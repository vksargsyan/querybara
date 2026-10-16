import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ENGINES, type IntrospectScope } from '@querybara/core';
import {
  compareSchemas,
  generateScript,
  renderHtmlReport,
  runMongoCommand,
  setAllSelected,
  type CompareOptions,
  type GeneratedScript,
  type RenameRule,
  type SchemaDiff,
  type SyncOperation,
} from '@querybara/sync';

import { cancellable, closeQuietly, drain, type Connection } from '../connect';
import { CliError, EXIT, formatError, type ExitCode } from '../errors';
import { engineOf, openMongo } from '../mongo';
import { compareFlags, type IgnoreName } from '../options';
import type { Style } from '../reporter';
import { formatDuration, openTarget, plural, targetFor, writeLine, type Runtime } from '../runtime';
import { confirmOperation } from '../safety';
import type { TargetOverrides } from '../target';

export interface CompareCommandOptions {
  /** PostgreSQL schemas to compare; empty: every non-system schema. */
  readonly schemas: readonly string[];
  readonly ignore: readonly IgnoreName[];
  /** Keep the sync engine's default ignores (auto-increment, definer, ownership, privileges). */
  readonly defaultIgnores: boolean;
  readonly renames: readonly RenameRule[];
  readonly detectRenames: boolean;
  /** Select destructive operations too (they start unselected, spec §13 step 5). */
  readonly includeDestructive: boolean;
  /** Write the deployment script here ('-': stdout). */
  readonly out?: string;
  /** Write the HTML report here. */
  readonly html?: string;
  readonly json: boolean;
  readonly apply: boolean;
  readonly yes: boolean;
  readonly tls?: TargetOverrides['tls'];
  readonly tunnel?: TargetOverrides['tunnel'];
}

/** What compare needs of an open side, SQL or MongoDB. */
type SyncConnection = Pick<Connection, 'session' | 'target' | 'close'>;

/** Opens a MongoDB side; the other side must be MongoDB too. */
async function openMongoSide(
  runtime: Runtime,
  spec: string,
  overrides: TargetOverrides,
): Promise<SyncConnection> {
  const target = await targetFor(runtime, spec, overrides);
  if (target.profile.engine !== 'mongodb') {
    throw new CliError(
      `Cannot compare ${ENGINES[target.profile.engine].displayName} with MongoDB`,
      {
        code: 'NOT_SUPPORTED',
        hint: 'MongoDB compares with MongoDB; move data between engines with "querybara transfer"',
      },
    );
  }
  if (!target.profile.options.defaultDatabase) {
    throw new CliError(`Name the database to compare in "${target.label}"`, {
      hint: 'Put it in the URI path: mongodb://host/<database>',
    });
  }
  return openMongo(runtime, target, overrides);
}

/** Opens one side of a compare: MongoDB targets through `openMongo`, SQL ones as usual. */
export function openSyncSide(
  runtime: Runtime,
  spec: string,
  overrides: TargetOverrides,
  mongo: boolean,
): Promise<SyncConnection> {
  return mongo ? openMongoSide(runtime, spec, overrides) : openTarget(runtime, spec, overrides);
}

/** Either target names a MongoDB connection. */
export function isMongoPair(runtime: Runtime, sourceSpec: string, targetSpec: string): boolean {
  return engineOf(runtime, sourceSpec) === 'mongodb' || engineOf(runtime, targetSpec) === 'mongodb';
}

/** Runs one script statement: MongoDB command documents fail on their write errors too. */
export async function runSyncStatement(
  runtime: Runtime,
  session: Connection['session'],
  sql: string,
): Promise<void> {
  await cancellable(runtime.interrupts, session, async (execution) => {
    if (session.engine === 'mongodb') await runMongoCommand(session, sql, execution.signal);
    else await drain(session, sql, execution);
  });
}

/**
 * `querybara compare <source> <target>`: structure compare (spec §13). Introspects both sides,
 * diffs them, prints the operations (or JSON), writes the script and HTML report, and with
 * --apply runs the script on the target and re-compares, failing loudly unless zero
 * differences remain (step 8). Exit 0: no differences; 1: differences found or remaining; 2:
 * error.
 */
export async function compareCommand(
  runtime: Runtime,
  sourceSpec: string,
  targetSpec: string,
  options: CompareCommandOptions,
): Promise<ExitCode> {
  if (options.json && options.out === '-') {
    throw new CliError('--json and --out - both write to stdout; write the script to a file');
  }
  const overrides: TargetOverrides = {
    ...(options.tls !== undefined ? { tls: options.tls } : {}),
    ...(options.tunnel !== undefined ? { tunnel: options.tunnel } : {}),
  };
  const mongo = isMongoPair(runtime, sourceSpec, targetSpec);
  let source: SyncConnection | undefined;
  let target: SyncConnection | undefined;
  try {
    source = await openSyncSide(runtime, sourceSpec, overrides, mongo);
    target = await openSyncSide(runtime, targetSpec, overrides, mongo);
    return await runCompare(runtime, source, target, options);
  } finally {
    await closeQuietly(source);
    await closeQuietly(target);
  }
}

async function runCompare(
  runtime: Runtime,
  source: SyncConnection,
  target: SyncConnection,
  options: CompareCommandOptions,
): Promise<ExitCode> {
  const { reporter } = runtime;
  const family = (engine: string): string =>
    engine === 'postgres' || engine === 'mongodb' ? engine : 'mysql';
  if (family(source.session.engine) !== family(target.session.engine)) {
    throw new CliError(
      `Cannot compare ${ENGINES[source.session.engine].displayName} with ${ENGINES[target.session.engine].displayName}`,
      {
        code: 'NOT_SUPPORTED',
        hint: 'Structure sync pairs PostgreSQL with PostgreSQL, MySQL/MariaDB with MySQL/MariaDB and MongoDB with MongoDB',
      },
    );
  }
  const pg = source.session.engine === 'postgres';
  if (!pg && options.schemas.length > 0) {
    reporter.warn(
      '--schema applies to PostgreSQL; MySQL, MariaDB and MongoDB compare the connected database',
    );
  }
  const scope: IntrospectScope =
    pg && options.schemas.length > 0 ? { schemas: options.schemas } : {};
  const compareOptions: CompareOptions = {
    ...compareFlags(options.ignore, options.defaultIgnores),
    detectRenames: options.detectRenames,
    renames: options.renames,
  };

  const started = runtime.ctx.now();
  reporter.progress('Reading both structures…', true);
  const [sourceSnapshot, targetSnapshot] = await Promise.all([
    source.session.introspect(scope),
    target.session.introspect(scope),
  ]);
  reporter.clearProgress();
  reporter.debug(`introspected both sides in ${formatDuration(runtime.ctx.now() - started)}`);

  let diff = compareSchemas(sourceSnapshot, targetSnapshot, compareOptions).diff;
  if (options.includeDestructive) diff = setAllSelected(diff, true, (op) => op.destructive);
  const script = generateScript(diff);
  const labels = {
    sourceLabel: `Source: ${source.target.label}`,
    targetLabel: `Target: ${target.target.label}`,
  };

  if (options.out !== undefined) {
    if (options.out === '-') await runtime.stdout.write(script.text);
    else {
      writeFileSync(resolve(runtime.ctx.cwd, options.out), script.text);
      reporter.info(
        `Wrote the script (${plural(script.statements.length, 'statement')}) to ${options.out}`,
      );
    }
  }
  if (options.html !== undefined) {
    const html = renderHtmlReport(diff, {
      ...labels,
      script,
      generatedAt: new Date().toISOString(),
    });
    writeFileSync(resolve(runtime.ctx.cwd, options.html), html);
    reporter.info(`Wrote the HTML report to ${options.html}`);
  }
  // The script on stdout (--out -) moves the human summary to stderr.
  const show = async (lines: readonly string[]): Promise<void> => {
    if (options.out === '-') for (const line of lines) reporter.print(line);
    else for (const line of lines) await writeLine(runtime, line);
  };
  const style = options.out === '-' ? reporter.style : runtime.out;
  if (!options.json) {
    await show([
      `Source: ${source.target.label} (${diff.sourceDatabase})`,
      `Target: ${target.target.label} (${diff.targetDatabase})`,
      ...diffLines(diff, style),
    ]);
  }

  if (!options.apply) {
    if (options.json)
      await writeLine(runtime, JSON.stringify(diffJson(diff, script, source, target), null, 2));
    return diff.identical ? EXIT.ok : EXIT.differences;
  }

  // --apply
  if (diff.identical) {
    if (options.json)
      await writeLine(runtime, JSON.stringify(diffJson(diff, script, source, target), null, 2));
    else reporter.info('Nothing to apply.');
    return EXIT.ok;
  }
  const applied = await applyScript(runtime, target, diff, script, options);
  if (!applied.ok) return EXIT.error;

  reporter.progress('Re-comparing…', true);
  const after = compareSchemas(
    sourceSnapshot,
    await target.session.introspect(scope),
    compareOptions,
  ).diff;
  reporter.clearProgress();
  const selected = new Set(diff.operations.filter((op) => op.selected).map((op) => op.id));
  const unconverged = after.operations.filter((op) => selected.has(op.id));
  if (options.json) {
    const report = {
      ...diffJson(diff, script, source, target),
      apply: {
        statements: applied.statements,
        identical: after.identical,
        remaining: after.operations.map(operationJson),
      },
    };
    await writeLine(runtime, JSON.stringify(report, null, 2));
  }
  if (after.identical) {
    reporter.print(
      style.green(
        `Applied ${plural(applied.statements, 'statement')} in ${formatDuration(applied.durationMs)}; the target now matches the source.`,
      ),
    );
    return EXIT.ok;
  }
  if (!options.json)
    await show([
      '',
      'Remaining differences after applying:',
      ...operationLines(after.operations, style),
    ]);
  reporter.error(
    unconverged.length > 0
      ? [
          `error: ${plural(after.operations.length, 'difference')} ${remain(after.operations.length)} after applying the script, ${unconverged.length} of them from operations that were applied`,
          '  hint: the target did not converge; review the remaining operations above and report the pair if the script was expected to fix them',
        ]
      : [
          `error: ${plural(after.operations.length, 'difference')} ${remain(after.operations.length)} after applying the script: operations that were not selected`,
          '  hint: destructive operations start unselected; pass --include-destructive to apply them too',
        ],
  );
  return EXIT.differences;
}

/**
 * Runs the deployment script on the target with progress, stopping at the first error. The
 * PostgreSQL script is one transaction and is rolled back on failure; MySQL/MariaDB DDL is not
 * transactional, so it needs --yes after a warning (spec §13).
 */
async function applyScript(
  runtime: Runtime,
  connection: SyncConnection,
  diff: SchemaDiff,
  script: GeneratedScript,
  options: CompareCommandOptions,
): Promise<{ ok: boolean; statements: number; durationMs: number }> {
  const { reporter, interrupts, ctx } = runtime;
  const { session, target } = connection;
  const selected = diff.operations.filter((op) => op.selected);
  if (script.statements.length === 0) {
    const destructive = diff.operations.filter((op) => op.destructive && !op.selected).length;
    reporter.error([
      'error: no operation is selected, so there is nothing to apply',
      ...(destructive > 0
        ? [
            `  hint: ${plural(destructive, 'destructive operation')} start unselected; pass --include-destructive`,
          ]
        : []),
    ]);
    return { ok: false, statements: 0, durationMs: 0 };
  }
  if (target.policy.readOnly) {
    throw new CliError(`"${target.label}" is read-only; the script was not applied`, {
      code: 'READ_ONLY',
    });
  }
  for (const warning of script.warnings) {
    if (warning.code === 'missing-dependency') reporter.warn(warning.message);
  }
  const destructive = selected.filter((op) => op.destructive).length;
  const question = `Apply ${plural(selected.length, 'operation')}${destructive > 0 ? ` (${destructive} destructive)` : ''} to "${target.label}"?`;
  if (!script.transactional) {
    reporter.warn(
      session.engine === 'mongodb'
        ? 'MongoDB runs the commands one by one: if a command fails, the commands before it stay applied and the target is left part-way. Back up the target first.'
        : `${ENGINES[session.engine].displayName} runs DDL outside transactions: if a statement fails, the statements before it stay applied and the target is left part-way. Back up the target first.`,
    );
    await confirmOperation(question, {
      yes: options.yes,
      prompter: ctx.prompter,
      reporter,
      requireFlag: true,
      hint: 'Pass --yes to apply a non-transactional script',
    });
  } else if (destructive > 0 || target.policy.production || target.policy.confirmWrites === true) {
    await confirmOperation(question, { yes: options.yes, prompter: ctx.prompter, reporter });
  }

  const statements = script.statements;
  const beginAt = script.transactional ? statements.indexOf('BEGIN') : -1;
  const started = ctx.now();
  for (let i = 0; i < statements.length; i++) {
    const sql = statements[i]!;
    reporter.progress(`Applying ${i + 1}/${statements.length}: ${firstLine(sql)}`);
    reporter.debug(`apply [${i + 1}/${statements.length}] ${firstLine(sql)}`);
    try {
      await runSyncStatement(runtime, session, sql);
    } catch (error) {
      reporter.clearProgress();
      if (session.inTransaction) await drain(session, 'ROLLBACK').catch(() => undefined);
      if (interrupts.interrupted) throw error;
      reporter.error(
        formatError(error, {
          verbose: reporter.verbose,
          statement: { index: i + 1, text: sql },
        }),
      );
      if (script.transactional && beginAt >= 0 && i > beginAt) {
        const before = beginAt;
        reporter.print(
          `The transaction was rolled back; the target is unchanged${before > 0 ? `, except ${plural(before, 'statement')} that must run before the transaction` : ''}.`,
        );
      } else {
        reporter.print(
          `Stopped at statement ${i + 1} of ${statements.length}; the ${plural(i, 'statement')} before it stay applied.`,
        );
      }
      return { ok: false, statements: i, durationMs: ctx.now() - started };
    }
  }
  reporter.clearProgress();
  return { ok: true, statements: statements.length, durationMs: ctx.now() - started };
}

function remain(count: number): string {
  return count === 1 ? 'remains' : 'remain';
}

function firstLine(sql: string): string {
  const line = sql.trim().split(/\r?\n/)[0] ?? '';
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

const SYMBOLS: Readonly<Record<SyncOperation['kind'], string>> = {
  create: '+',
  alter: '~',
  drop: '-',
  rename: '→',
};

/** The human summary: counts, then one line per operation, then warnings. */
export function diffLines(diff: SchemaDiff, style: Style): string[] {
  if (diff.operations.length === 0) return ['No differences.'];
  const counts: string[] = [];
  const count = (kind: SyncOperation['kind']): number =>
    diff.operations.filter((op) => op.kind === kind).length;
  for (const kind of ['create', 'alter', 'drop', 'rename'] as const) {
    if (count(kind) > 0) counts.push(`${count(kind)} ${kind}`);
  }
  const unselected = diff.operations.filter((op) => !op.selected);
  const destructive = diff.operations.filter((op) => op.destructive);
  const notes: string[] = [];
  if (destructive.length > 0) notes.push(`${destructive.length} destructive`);
  if (unselected.length > 0) notes.push(`${unselected.length} not selected`);
  const lines = [
    `${plural(diff.operations.length, 'difference')}: ${counts.join(', ')}${notes.length > 0 ? ` (${notes.join(', ')})` : ''}`,
    '',
    ...operationLines(diff.operations, style),
  ];
  if (diff.warnings.length > 0) {
    lines.push('', 'Warnings:', ...diff.warnings.map((w) => `  ! ${w.message}`));
  }
  return lines;
}

export function operationLines(operations: readonly SyncOperation[], style: Style): string[] {
  const kindWidth = Math.max(0, ...operations.map((op) => op.objectKind.length));
  const nameWidth = Math.min(48, Math.max(0, ...operations.map((op) => op.qualifiedName.length)));
  const lines: string[] = [];
  for (const op of operations) {
    const paint = (text: string): string =>
      op.kind === 'create'
        ? style.green(text)
        : op.kind === 'drop'
          ? style.red(text)
          : style.yellow(text);
    const flags = [op.destructive ? 'destructive' : '', op.selected ? '' : 'not selected']
      .filter(Boolean)
      .join(', ');
    const [first, ...more] = op.changes;
    const detail = [first, flags ? `[${flags}]` : ''].filter(Boolean).join(' ');
    lines.push(
      `  ${paint(SYMBOLS[op.kind])} ${op.objectKind.padEnd(kindWidth)}  ${op.qualifiedName.padEnd(nameWidth)}${detail ? `  ${detail}` : ''}`.trimEnd(),
    );
    const indent = ' '.repeat(4 + kindWidth + 2 + nameWidth + 2);
    for (const change of more) lines.push(`${indent}${change}`);
    for (const warning of op.warnings) {
      if (warning.code !== 'rebuild')
        lines.push(`${indent}${style.dim(`${warning.code}: ${warning.message}`)}`);
    }
  }
  return lines;
}

function operationJson(op: SyncOperation): Record<string, unknown> {
  return {
    id: op.id,
    kind: op.kind,
    objectKind: op.objectKind,
    name: op.name,
    qualifiedName: op.qualifiedName,
    ...(op.parent !== undefined ? { parent: op.parent } : {}),
    ...(op.schema !== undefined ? { schema: op.schema } : {}),
    destructive: op.destructive,
    selected: op.selected,
    changes: op.changes,
    warnings: op.warnings,
    dependsOn: op.dependsOn,
    ...(op.reason !== undefined ? { reason: op.reason } : {}),
    statements: op.statements,
    ...(op.sourceDdl !== undefined ? { sourceDdl: op.sourceDdl } : {}),
    ...(op.targetDdl !== undefined ? { targetDdl: op.targetDdl } : {}),
  };
}

/** The machine-readable diff (--json). */
export function diffJson(
  diff: SchemaDiff,
  script: GeneratedScript,
  source: Pick<SyncConnection, 'target' | 'session'>,
  target: Pick<SyncConnection, 'target' | 'session'>,
): Record<string, unknown> {
  const side = (
    c: Pick<SyncConnection, 'target' | 'session'>,
    database: string,
  ): Record<string, unknown> => ({
    label: c.target.label,
    engine: c.session.engine,
    serverVersion: c.session.serverVersion,
    database,
  });
  const counts = (kind: SyncOperation['kind']): number =>
    diff.operations.filter((op) => op.kind === kind).length;
  return {
    source: side(source, diff.sourceDatabase),
    target: side(target, diff.targetDatabase),
    identical: diff.identical,
    summary: {
      total: diff.operations.length,
      create: counts('create'),
      alter: counts('alter'),
      drop: counts('drop'),
      rename: counts('rename'),
      destructive: diff.operations.filter((op) => op.destructive).length,
      selected: diff.operations.filter((op) => op.selected).length,
    },
    options: diff.options,
    warnings: diff.warnings,
    operations: diff.operations.map(operationJson),
    script: {
      transactional: script.transactional,
      statements: script.statements,
      warnings: script.warnings,
    },
  };
}
