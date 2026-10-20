import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { QuerybaraError, type Session } from '@querybara/core';
import type { DataRowAction, DataRowDiff, DataTableResult } from '@querybara/ipc';
import {
  EJSON,
  formatShell,
  isBsonDocument,
  type BsonDocument,
  type BsonValue,
} from '@querybara/mongo-tools';
import {
  DOCUMENT_COLUMNS,
  MongoDataSyncScriptBuilder,
  compareCollectionData,
  idDisplay,
  type MongoFindSession,
  type RowDiff,
} from '@querybara/sync';

import type { DataCompareJob } from '../shared/sync-jobs';
import {
  MANIFEST_FILE,
  MONGO_ROW_COLUMNS,
  SPOOL_MAX_CELL,
  SPOOL_MAX_ROWS,
  SPOOL_PAGE_SIZE,
  diffsFile,
  rowPageFile,
  statementsFile,
  type SpoolManifest,
  type SpoolTable,
} from '../shared/sync-spool';
import {
  bothSides,
  cancelledError,
  isCancelled,
  plural,
  sideInfo,
  type SyncJobContext,
  type SyncJobOutcome,
} from './sync-common';
import { LineWriter, dataSummary, encodeDiff } from './sync-files';

/**
 * MongoDB data compare in the job runner (spec §13, data sync for documents): collections pair
 * by name, each is compared document by document in `_id` order (`compareCollectionData`), and
 * the differences are spooled like a SQL compare's: row pages for the grid (the `_id`, the
 * top-level fields concerned and their values) and batched write commands per action, which
 * apply and the script read back.
 */

const ACTIONS: readonly DataRowAction[] = ['insert', 'update', 'delete'];
const BATCH_DOCUMENTS = 500;

function perAction<T>(make: (action: DataRowAction) => T): Record<DataRowAction, T> {
  return { insert: make('insert'), update: make('update'), delete: make('delete') };
}

/** A session that can read documents (the driver's MongoSession), checked structurally. */
function asFindSession(session: Session, side: string): MongoFindSession {
  const candidate = session as Partial<MongoFindSession>;
  if (session.engine !== 'mongodb' || typeof candidate.find !== 'function') {
    throw new QuerybaraError({
      code: 'NOT_SUPPORTED',
      message: `The ${side} is not a MongoDB connection`,
    });
  }
  return session as unknown as MongoFindSession;
}

function cut(text: string): string {
  return text.length > SPOOL_MAX_CELL ? `${text.slice(0, SPOOL_MAX_CELL)}…` : text;
}

function parseDocument(text: string): BsonDocument {
  const value = EJSON.parse(text, { relaxed: false }) as BsonValue;
  return isBsonDocument(value) ? value : {};
}

function inline(value: BsonValue): string {
  return cut(formatShell(value, { lineWidth: Infinity, maxStringLength: 200 }));
}

function fieldsOf(doc: BsonDocument): string[] {
  return Object.keys(doc).filter((f) => f !== '_id');
}

/** Only `fields` of a document, in the order given (fields it lacks are left out). */
function pick(doc: BsonDocument, fields: readonly string[]): BsonDocument {
  const out: BsonDocument = {};
  for (const field of fields) if (field in doc) out[field] = doc[field]!;
  return out;
}

/** The grid row of one difference: `_id`, the fields concerned, and their values. */
export function mongoRow(diff: RowDiff): DataRowDiff {
  const id = idDisplay(String(diff.key[0]));
  if (diff.action === 'update') {
    const fields = (diff.changedColumns ?? []).filter((f) => f !== '(field order)');
    const source = parseDocument(String(diff.sourceRow?.[1] ?? '{}'));
    const target = parseDocument(String(diff.targetRow?.[1] ?? '{}'));
    const label = cut((diff.changedColumns ?? []).join(', '));
    return {
      action: 'update',
      key: [id],
      source: [id, label, inline(fields.length > 0 ? pick(source, fields) : source)],
      target: [id, label, inline(fields.length > 0 ? pick(target, fields) : target)],
      changed: ['values'],
    };
  }
  const text = String((diff.action === 'insert' ? diff.sourceRow : diff.targetRow)?.[1] ?? '{}');
  const doc = parseDocument(text);
  const cells = [id, cut(fieldsOf(doc).join(', ')), inline(doc)];
  return diff.action === 'insert'
    ? { action: 'insert', key: [id], source: cells }
    : { action: 'delete', key: [id], target: cells };
}

/** One collection's spool: row pages for the grid and write commands per action. */
class CollectionSpool {
  readonly statements = perAction(() => 0);
  readonly stored = perAction(() => 0);
  /** Statements that cover the stored rows; set once they are all in. */
  readonly #head = perAction((): number | undefined => undefined);
  readonly #builders: Record<DataRowAction, MongoDataSyncScriptBuilder>;
  readonly #files: Record<DataRowAction, LineWriter>;
  readonly #diffs: Record<DataRowAction, LineWriter>;
  readonly #pages = perAction((): DataRowDiff[] => []);
  readonly #pageNumbers = perAction(() => 0);

  constructor(
    private readonly dir: string,
    private readonly index: number,
    collection: string,
  ) {
    this.#builders = perAction(
      () => new MongoDataSyncScriptBuilder({ collection, batchSize: BATCH_DOCUMENTS }),
    );
    this.#files = perAction((action) => new LineWriter(join(dir, statementsFile(index, action))));
    this.#diffs = perAction((action) => new LineWriter(join(dir, diffsFile(index, action))));
  }

  async add(diff: RowDiff): Promise<void> {
    const action = diff.action;
    for (const command of this.#builders[action].add(diff)) await this.#statement(action, command);
    if (this.stored[action] >= SPOOL_MAX_ROWS) return;
    this.stored[action]++;
    await this.#diffs[action].write(encodeDiff(diff));
    this.#pages[action].push(mongoRow(diff));
    if (this.#pages[action].length >= SPOOL_PAGE_SIZE) await this.#flushPage(action);
    if (this.stored[action] === SPOOL_MAX_ROWS) await this.#endHead(action);
  }

  /** Statements per action that cover the stored rows (the first ones of each file). */
  heads(): Record<DataRowAction, number> {
    return perAction((action) => this.#head[action] ?? this.statements[action]);
  }

  async finish(): Promise<void> {
    for (const action of ACTIONS) {
      await this.#endHead(action);
      await this.#flushPage(action);
      await this.#files[action].close();
      await this.#diffs[action].close();
    }
  }

  destroy(): void {
    for (const action of ACTIONS) {
      this.#files[action].destroy();
      this.#diffs[action].destroy();
    }
  }

  /**
   * Flushes the batch the stored rows end in, so their statements stand apart from the rest's:
   * a sync of only some of them builds those statements again and keeps the others.
   */
  async #endHead(action: DataRowAction): Promise<void> {
    for (const command of this.#builders[action].flush()) await this.#statement(action, command);
    this.#head[action] ??= this.statements[action];
  }

  async #statement(action: DataRowAction, command: string): Promise<void> {
    this.statements[action]++;
    await this.#files[action].write(JSON.stringify(command));
  }

  async #flushPage(action: DataRowAction): Promise<void> {
    const rows = this.#pages[action].splice(0);
    if (rows.length === 0) return;
    const page = this.#pageNumbers[action]++;
    await writeFile(join(this.dir, rowPageFile(this.index, action, page)), JSON.stringify(rows));
  }
}

/** A compare side's database: the one chosen, or the session's own. */
function databaseOf(side: { readonly database?: string | undefined }, fallback: string): string {
  return side.database !== undefined && side.database !== '' ? side.database : fallback;
}

/**
 * Compares the documents of every collection both databases have (or the ones the job names)
 * and spools the differences. Views and time series collections are skipped with a reason; a
 * collection whose compare fails is reported with its error and the others still compare.
 */
export async function runMongoDataCompare(
  job: DataCompareJob,
  context: SyncJobContext,
): Promise<SyncJobOutcome> {
  const started = performance.now();
  const { source, target } = bothSides(context);
  const { signal } = context;
  if (source.engine !== 'mongodb' || target.engine !== 'mongodb') {
    throw new QuerybaraError({
      code: 'NOT_SUPPORTED',
      message: 'MongoDB data compares with another MongoDB database',
      hint: 'Move documents between MongoDB and SQL databases with data transfer instead.',
    });
  }
  const sourceFind = asFindSession(source, 'source');
  const targetFind = asFindSession(target, 'target');
  context.progress({ phase: 'Reading both collection lists' });
  const [sourceSnapshot, targetSnapshot] = await Promise.all([
    source.introspect({
      ...(job.source.database ? { database: job.source.database } : {}),
      include: ['table'],
    }),
    target.introspect({
      ...(job.target.database ? { database: job.target.database } : {}),
      include: ['table'],
    }),
  ]);
  if (signal.aborted) throw cancelledError();
  const sourceDb = databaseOf(job.source, sourceSnapshot.database);
  const targetDb = databaseOf(job.target, targetSnapshot.database);
  const sourceCollections = sourceSnapshot.schemas[0]?.tables ?? [];
  const targetCollections = new Map(
    (targetSnapshot.schemas[0]?.tables ?? []).map((t) => [t.name, t]),
  );
  const wanted = job.tables !== undefined ? new Set(job.tables.map((t) => t.name)) : undefined;
  const skipped: { name: string; reason: string }[] = [];
  const names: string[] = [];
  for (const collection of sourceCollections) {
    if (wanted && !wanted.has(collection.name)) continue;
    const other = targetCollections.get(collection.name);
    if (other === undefined) {
      skipped.push({
        name: collection.name,
        reason: 'only in the source: create it first (structure compare), then compare again',
      });
    } else if (
      collection.options['type'] === 'timeseries' ||
      other.options['type'] === 'timeseries'
    ) {
      skipped.push({ name: collection.name, reason: 'time series collections are not compared' });
    } else {
      names.push(collection.name);
    }
  }
  for (const name of targetCollections.keys()) {
    if (wanted && !wanted.has(name)) continue;
    if (!sourceCollections.some((c) => c.name === name)) {
      skipped.push({ name, reason: 'only in the target' });
    }
  }
  for (const skip of skipped) context.log('warning', `Skipped ${skip.name}: ${skip.reason}`);

  const ignoreFields = job.options.ignoreColumns ?? [];
  const tables: SpoolTable[] = [];
  let rowsCompared = 0;
  for (const [index, name] of names.entries()) {
    if (signal.aborted) throw cancelledError();
    const tableStarted = performance.now();
    const phase = `Comparing ${name} (${index + 1} of ${names.length})`;
    context.progress({ phase, table: name, rowsRead: rowsCompared });
    const spool = new CollectionSpool(job.spoolDir, index, name);
    const entry: SpoolTable = {
      index,
      name,
      source: { name },
      target: { name },
      keyColumns: ['_id'],
      commonColumns: ['_id'],
      compared: [],
      columns: [...MONGO_ROW_COLUMNS],
      counts: { inserts: 0, updates: 0, deletes: 0, equal: 0, sourceRows: 0, targetRows: 0 },
      checksums: false,
      ranges: 0,
      matchedRanges: 0,
      stored: { insert: 0, update: 0, delete: 0 },
      statements: { insert: 0, update: 0, delete: 0 },
      durationMs: 0,
      sourceColumns: [...DOCUMENT_COLUMNS],
      targetColumns: [...DOCUMENT_COLUMNS],
      targetKinds: {},
    };
    try {
      for await (const event of compareCollectionData(
        sourceFind,
        targetFind,
        {
          source: { db: sourceDb, collection: name },
          target: { db: targetDb, collection: name },
          ...(ignoreFields.length > 0 ? { ignoreFields } : {}),
        },
        {
          ...(job.options.ignoreFieldOrder !== undefined
            ? { ignoreFieldOrder: job.options.ignoreFieldOrder }
            : {}),
          ...(job.options.ignoreNumericTypes !== undefined
            ? { ignoreNumericTypes: job.options.ignoreNumericTypes }
            : {}),
          signal,
        },
      )) {
        if (event.type === 'diff') {
          await spool.add(event.diff);
        } else if (event.type === 'progress') {
          context.progress({ phase, table: name, rowsRead: rowsCompared + event.rowsCompared });
        } else {
          rowsCompared += event.summary.sourceRows + event.summary.targetRows;
          entry.counts = { ...event.summary };
        }
      }
      await spool.finish();
    } catch (error) {
      spool.destroy();
      if (isCancelled(error, signal)) throw cancelledError();
      const message = error instanceof Error ? error.message : String(error);
      entry.error = message;
      context.log('error', `${name}: ${message}`);
    }
    entry.stored = { ...spool.stored };
    entry.statements = { ...spool.statements };
    entry.headStatements = spool.heads();
    entry.durationMs = Math.round(performance.now() - tableStarted);
    tables.push(entry);
    const c = entry.counts;
    if (!entry.error) {
      context.log(
        'info',
        `${name}: ${c.inserts} to insert, ${c.updates} to update, ${c.deletes} to delete, ${c.equal} identical`,
      );
    }
  }
  const manifest: SpoolManifest = {
    version: 1,
    dialect: 'mongodb',
    database: targetDb,
    pageSize: SPOOL_PAGE_SIZE,
    tables,
    order: tables.map((t) => t.index),
    apply: { disableForeignKeyChecks: false, disableTriggers: false },
  };
  await writeFile(join(job.spoolDir, MANIFEST_FILE), JSON.stringify(manifest));
  const differing = tables.filter(
    (t) => t.counts.inserts + t.counts.updates + t.counts.deletes > 0,
  );
  const failed = tables.filter((t) => t.error !== undefined);
  const totals = tables.reduce(
    (sum, t) => ({
      inserts: sum.inserts + t.counts.inserts,
      updates: sum.updates + t.counts.updates,
      deletes: sum.deletes + t.counts.deletes,
    }),
    { inserts: 0, updates: 0, deletes: 0 },
  );
  const outcome =
    differing.length === 0
      ? `${plural(tables.length, 'collection')} compared, no differences${failed.length > 0 ? `; ${failed.length} failed` : ''}`
      : `${plural(differing.length, 'collection')} of ${tables.length} differ: ${totals.inserts} to insert, ${totals.updates} to update, ${totals.deletes} to delete${failed.length > 0 ? `; ${failed.length} failed` : ''}`;
  context.log('info', outcome);
  const result: DataTableResult[] = tables.map(
    ({ sourceColumns: _s, targetColumns: _t, targetKinds: _k, headStatements: _h, ...table }) =>
      table,
  );
  return {
    summary: dataSummary('completed', performance.now() - started, outcome, {
      rowsRead: rowsCompared,
      rowsSkipped: 0,
    }),
    errors: failed.map((t) => ({ message: `${t.name}: ${t.error ?? ''}` })),
    result: {
      kind: 'data',
      source: sideInfo(context.sourceProfile!, source, sourceDb, job.source),
      target: sideInfo(context.targetProfile, target, targetDb, job.target),
      tables: result,
      skipped,
      pageSize: SPOOL_PAGE_SIZE,
    },
  };
}
