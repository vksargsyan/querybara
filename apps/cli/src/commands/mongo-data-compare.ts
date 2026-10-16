import {
  createReadStream,
  createWriteStream,
  mkdtempSync,
  rmSync,
  type WriteStream,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { EJSON, formatShell, isBsonDocument, type BsonDocument } from '@querybara/mongo-tools';
import {
  MONGO_SYNC_PRELUDE,
  MongoDataSyncScriptBuilder,
  compareCollectionData,
  idDisplay,
  mongoSyncLine,
  type MergeSummary,
  type MongoFindSession,
  type RowAction,
  type RowDiff,
} from '@querybara/sync';

import { closeQuietly } from '../connect';
import { CliError, EXIT, formatError, type ExitCode } from '../errors';
import { singleLine, truncateToWidth } from '../output/width';
import { formatDuration, plural, writeLine, type Runtime } from '../runtime';
import { confirmOperation } from '../safety';
import type { TargetOverrides } from '../target';
import { openSyncSide, runSyncStatement } from './compare';
import type { DataCompareCommandOptions } from './data-compare';

/**
 * `querybara data-compare` on two MongoDB targets (spec §13, data sync for documents): the
 * `--table` names a collection, documents are compared by `_id` in BSON order, and the sync
 * script is a mongosh script of batched insert, delete and replace-by-_id commands, spooled to
 * temporary files so memory stays flat. MongoDB writes run outside transactions here, so
 * --apply needs --yes (or a confirmation) and says what stayed applied when a command fails.
 */

type Side = Awaited<ReturnType<typeof openSyncSide>>;

const ACTION_ORDER: readonly RowAction[] = ['delete', 'update', 'insert'];

/** Flags that only mean something for SQL tables. */
const SQL_ONLY: readonly (keyof DataCompareCommandOptions)[] = [
  'key',
  'columns',
  'floatTolerance',
  'trim',
  'caseInsensitive',
  'disableForeignKeyChecks',
];

const FLAG_NAMES: Readonly<Partial<Record<keyof DataCompareCommandOptions, string>>> = {
  key: '--key',
  columns: '--columns',
  floatTolerance: '--float-tolerance',
  trim: '--trim',
  caseInsensitive: '--case-insensitive',
  disableForeignKeyChecks: '--disable-fk-checks',
};

/** Batched commands per action in temporary JSON-lines files. */
class CommandSpool {
  readonly #dir = mkdtempSync(join(tmpdir(), 'querybara-mongo-sync-'));
  readonly #builders: Record<RowAction, MongoDataSyncScriptBuilder>;
  readonly #files: Record<RowAction, { path: string; stream: WriteStream }>;
  count = 0;

  constructor(collection: string, batchSize: number | undefined) {
    const builder = (): MongoDataSyncScriptBuilder =>
      new MongoDataSyncScriptBuilder({
        collection,
        ...(batchSize !== undefined ? { batchSize } : {}),
      });
    this.#builders = { insert: builder(), update: builder(), delete: builder() };
    const file = (action: RowAction): { path: string; stream: WriteStream } => {
      const path = join(this.#dir, `${action}.jsonl`);
      return { path, stream: createWriteStream(path) };
    };
    this.#files = { insert: file('insert'), update: file('update'), delete: file('delete') };
  }

  async add(diff: RowDiff): Promise<void> {
    await this.#write(diff.action, this.#builders[diff.action].add(diff));
  }

  async finish(): Promise<void> {
    for (const action of ACTION_ORDER) await this.#write(action, this.#builders[action].flush());
    await Promise.all(
      ACTION_ORDER.map(
        (action) => new Promise<void>((done) => this.#files[action].stream.end(() => done())),
      ),
    );
  }

  /** Every command in run order: deletes, updates, inserts. */
  async *commands(): AsyncGenerator<string> {
    for (const action of ACTION_ORDER) {
      const lines = createInterface({ input: createReadStream(this.#files[action].path) });
      for await (const line of lines) if (line !== '') yield JSON.parse(line) as string;
    }
  }

  async writeScript(path: string, database: string): Promise<void> {
    const out = createWriteStream(path);
    const write = (text: string): Promise<void> =>
      new Promise((done, fail) => {
        if (out.write(text)) done();
        else out.once('drain', done).once('error', fail);
      });
    await write(`db = db.getSiblingDB(${JSON.stringify(database)});\n`);
    for (const line of MONGO_SYNC_PRELUDE) await write(`${line}\n`);
    if (this.count === 0) await write('// No differences to sync\n');
    for await (const command of this.commands()) await write(`${mongoSyncLine(command)}\n`);
    await new Promise<void>((done) => out.end(() => done()));
  }

  dispose(): void {
    for (const action of ACTION_ORDER) this.#files[action].stream.destroy();
    rmSync(this.#dir, { recursive: true, force: true });
  }

  async #write(action: RowAction, commands: readonly string[]): Promise<void> {
    const stream = this.#files[action].stream;
    for (const command of commands) {
      this.count++;
      if (!stream.write(`${JSON.stringify(command)}\n`)) {
        await new Promise<void>((done) => stream.once('drain', done));
      }
    }
  }
}

interface Run {
  readonly summary: MergeSummary;
  readonly samples: readonly RowDiff[];
  readonly durationMs: number;
}

function databaseOf(side: Side): string {
  return side.target.profile.options.defaultDatabase ?? '';
}

async function compare(
  runtime: Runtime,
  source: Side,
  target: Side,
  options: DataCompareCommandOptions,
  spool: CommandSpool | undefined,
): Promise<Run> {
  const { reporter, interrupts, ctx } = runtime;
  const selected = new Set(options.actions);
  const controller = new AbortController();
  const started = ctx.now();
  const samples: RowDiff[] = [];
  let summary: MergeSummary | undefined;
  await interrupts.guard(
    () => controller.abort(),
    async () => {
      for await (const event of compareCollectionData(
        source.session as unknown as MongoFindSession,
        target.session as unknown as MongoFindSession,
        {
          source: { db: databaseOf(source), collection: options.table },
          target: { db: databaseOf(target), collection: options.targetTable ?? options.table },
          ...(options.ignoreColumns !== undefined ? { ignoreFields: options.ignoreColumns } : {}),
        },
        {
          ...(options.fieldOrder ? { ignoreFieldOrder: false } : {}),
          ...(options.ignoreNumberTypes ? { ignoreNumericTypes: true } : {}),
          ...(options.batchSize !== undefined ? { pageSize: options.batchSize } : {}),
          signal: controller.signal,
        },
      )) {
        if (event.type === 'progress') {
          reporter.progress(`Comparing… ${plural(event.rowsCompared, 'document')}`);
        } else if (event.type === 'diff') {
          if (!selected.has(event.diff.action)) continue;
          if (samples.length < options.showRows) samples.push(event.diff);
          await spool?.add(event.diff);
        } else {
          summary = event.summary;
        }
      }
    },
  );
  reporter.clearProgress();
  if (!summary)
    throw new CliError('The data compare ended without a summary', { code: 'INTERNAL' });
  return { summary, samples, durationMs: ctx.now() - started };
}

function documentOf(text: string | undefined): BsonDocument {
  const value: unknown = text === undefined ? {} : EJSON.parse(text, { relaxed: false });
  return isBsonDocument(value) ? value : {};
}

function inline(value: Parameters<typeof formatShell>[0]): string {
  return singleLine(truncateToWidth(formatShell(value, { lineWidth: Infinity }), 60));
}

function sampleLines(samples: readonly RowDiff[], style: Runtime['out']): string[] {
  return samples.map((diff) => {
    const id = `_id=${idDisplay(String(diff.key[0]))}`;
    if (diff.action === 'insert') {
      return `  ${style.green('+')} ${id}  ${inline(documentOf(String(diff.sourceRow?.[1])))}`;
    }
    if (diff.action === 'delete') return `  ${style.red('-')} ${id}`;
    const source = documentOf(String(diff.sourceRow?.[1]));
    const target = documentOf(String(diff.targetRow?.[1]));
    const changes = (diff.changedColumns ?? []).map((field) => {
      const show = (doc: BsonDocument): string =>
        field in doc ? inline(doc[field]!) : '(missing)';
      return `${field}: ${show(target)} → ${show(source)}`;
    });
    return `  ${style.yellow('~')} ${id}  ${changes.join(', ')}`;
  });
}

function json(
  source: Side,
  target: Side,
  run: Run,
  options: DataCompareCommandOptions,
): Record<string, unknown> {
  const doc = (text: unknown): unknown => (typeof text === 'string' ? JSON.parse(text) : undefined);
  return {
    source: { label: source.target.label, database: databaseOf(source), collection: options.table },
    target: {
      label: target.target.label,
      database: databaseOf(target),
      collection: options.targetTable ?? options.table,
    },
    key: ['_id'],
    actions: options.actions,
    summary: run.summary,
    differences: run.samples.map((diff) => ({
      action: diff.action,
      _id: doc(diff.key[0]),
      ...(diff.changedColumns ? { changedFields: diff.changedColumns } : {}),
      ...(diff.sourceRow ? { source: doc(diff.sourceRow[1]) } : {}),
      ...(diff.targetRow ? { target: doc(diff.targetRow[1]) } : {}),
    })),
  };
}

/** Runs the spooled commands, stopping at the first failure (no transaction to roll back). */
async function apply(
  runtime: Runtime,
  target: Side,
  spool: CommandSpool,
  counts: Readonly<Record<RowAction, number>>,
  options: DataCompareCommandOptions,
): Promise<{ durationMs: number } | undefined> {
  const { reporter, ctx } = runtime;
  if (target.target.policy.readOnly) {
    throw new CliError(`"${target.target.label}" is read-only; the sync script was not applied`, {
      code: 'READ_ONLY',
    });
  }
  const parts = options.actions.map((action) => `${counts[action]} ${action}`).join(', ');
  reporter.warn(
    'MongoDB runs the commands one by one: if a command fails, the ones before it stay applied.',
  );
  await confirmOperation(`Apply ${parts} to "${target.target.label}"?`, {
    yes: options.yes,
    prompter: ctx.prompter,
    reporter,
    requireFlag: true,
    hint: 'Pass --yes to apply MongoDB commands, which run outside transactions',
  });
  const started = ctx.now();
  let index = 0;
  for await (const command of spool.commands()) {
    index++;
    reporter.progress(`Applying command ${index}/${spool.count}…`);
    try {
      await runSyncStatement(runtime, target.session, command);
    } catch (error) {
      reporter.clearProgress();
      if (runtime.interrupts.interrupted) throw error;
      reporter.error(
        formatError(error, { verbose: reporter.verbose, statement: { index, text: command } }),
      );
      reporter.print(
        index > 1
          ? `Stopped at command ${index} of ${spool.count}; the ${plural(index - 1, 'command')} before it stay applied.`
          : 'Stopped at the first command; nothing was applied.',
      );
      return undefined;
    }
  }
  reporter.clearProgress();
  return { durationMs: ctx.now() - started };
}

export async function mongoDataCompareCommand(
  runtime: Runtime,
  sourceSpec: string,
  targetSpec: string,
  options: DataCompareCommandOptions,
): Promise<ExitCode> {
  const sqlOnly = SQL_ONLY.filter((key) => options[key] !== undefined && options[key] !== false);
  if (sqlOnly.length > 0) {
    throw new CliError(
      `${sqlOnly.map((key) => FLAG_NAMES[key]).join(', ')} ${sqlOnly.length === 1 ? 'applies' : 'apply'} to SQL tables, not MongoDB collections`,
      {
        hint: 'MongoDB documents are compared whole, by _id; see --ignore-columns, --field-order and --ignore-number-types',
      },
    );
  }
  const overrides: TargetOverrides = {
    ...(options.tls !== undefined ? { tls: options.tls } : {}),
    ...(options.tunnel !== undefined ? { tunnel: options.tunnel } : {}),
  };
  let source: Side | undefined;
  let target: Side | undefined;
  let spool: CommandSpool | undefined;
  try {
    source = await openSyncSide(runtime, sourceSpec, overrides, true);
    target = await openSyncSide(runtime, targetSpec, overrides, true);
    const collection = options.targetTable ?? options.table;
    if (options.out !== undefined || options.apply) {
      spool = new CommandSpool(collection, options.batchSize);
    }
    const run = await compare(runtime, source, target, options, spool);
    const counts = {
      insert: run.summary.inserts,
      update: run.summary.updates,
      delete: run.summary.deletes,
    };
    const pending = options.actions.reduce((sum, action) => sum + counts[action], 0);
    const selected = new Set(options.actions);
    if (options.json) {
      if (!options.apply)
        await writeLine(runtime, JSON.stringify(json(source, target, run, options), null, 2));
    } else {
      await writeLine(
        runtime,
        `Collection ${databaseOf(source)}.${options.table} → ${databaseOf(target)}.${collection} (key: _id; whole documents compared)`,
      );
      for (const action of ['insert', 'update', 'delete'] as const) {
        const note = selected.has(action) ? '' : '  (not selected)';
        await writeLine(
          runtime,
          `  ${action.padEnd(7)} ${counts[action].toLocaleString('en-US').padStart(10)}${note}`,
        );
      }
      await writeLine(
        runtime,
        `  ${'equal'.padEnd(7)} ${run.summary.equal.toLocaleString('en-US').padStart(10)}`,
      );
      runtime.reporter.info(
        `Compared ${plural(run.summary.sourceRows, 'source document')} with ${plural(run.summary.targetRows, 'target document')} in ${formatDuration(run.durationMs)} (streamed in _id order)`,
      );
      if (run.samples.length > 0) {
        await writeLine(runtime, '');
        await writeLine(runtime, `Document differences (first ${run.samples.length}):`);
        for (const line of sampleLines(run.samples, runtime.out)) await writeLine(runtime, line);
      }
    }

    if (spool) await spool.finish();
    if (options.out !== undefined && spool) {
      await spool.writeScript(resolve(runtime.ctx.cwd, options.out), databaseOf(target));
      runtime.reporter.info(
        `Wrote the sync script (${plural(spool.count, 'command')}) to ${options.out}`,
      );
    }
    if (!options.apply) return pending > 0 ? EXIT.differences : EXIT.ok;

    if (pending === 0 || !spool) {
      if (options.json)
        await writeLine(runtime, JSON.stringify(json(source, target, run, options), null, 2));
      else runtime.reporter.info('Nothing to apply.');
      return EXIT.ok;
    }
    const applied = await apply(runtime, target, spool, counts, options);
    if (!applied) return EXIT.error;
    const after = await compare(runtime, source, target, { ...options, showRows: 0 }, undefined);
    const left = {
      insert: after.summary.inserts,
      update: after.summary.updates,
      delete: after.summary.deletes,
    };
    const remaining = options.actions.reduce((sum, action) => sum + left[action], 0);
    if (options.json) {
      await writeLine(
        runtime,
        JSON.stringify(
          {
            ...json(source, target, run, options),
            apply: { commands: spool.count, remaining: left },
          },
          null,
          2,
        ),
      );
    }
    if (remaining === 0) {
      runtime.reporter.print(
        runtime.reporter.style.green(
          `Applied ${plural(pending, 'document change')} in ${formatDuration(applied.durationMs)}; the target now matches the source for ${options.actions.join(', ')}.`,
        ),
      );
      return EXIT.ok;
    }
    runtime.reporter.error([
      `error: ${plural(remaining, 'document difference')} ${remaining === 1 ? 'remains' : 'remain'} after applying the sync script (insert ${left.insert}, update ${left.update}, delete ${left.delete})`,
      '  hint: documents may have changed on either side while syncing; compare again',
    ]);
    return EXIT.differences;
  } finally {
    spool?.dispose();
    await closeQuietly(source);
    await closeQuietly(target);
  }
}
