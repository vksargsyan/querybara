import { isSqlEngine, type SqlDialect, type TableDef } from '@querybara/core';
import type { StoredProfile } from '@querybara/ipc';
import { quoteIdent, quoteQualified, quoteString } from '@querybara/sql-tools';
import { formatStatements } from '@querybara/sync';
import { create } from 'zustand';

import { errorMessage } from '../lib/errors';
import { confirm } from './dialogs';
import { runScript, type ScriptOutcome } from './designer';
import { loadChildren, tablesFolderPath, type TableLocation } from './explorer';
import { copyName } from './mongo/collection-actions';
import { findTable, invalidateMetadata, loadSnapshot } from './metadata';
import { SessionLane } from './session-lane';
import { tableViewsOf } from './table-view';
import { toastError } from './toasts';

/**
 * Navicat's row and copy actions on a table, from the explorer's menu (spec §5): Empty Table
 * (DELETE FROM: every row goes, the auto-increment counter keeps its place), Truncate Table
 * (TRUNCATE: every row goes and the counter starts over) and Duplicate Table (a new table with
 * the same columns, keys, indexes and checks, with or without the rows). Each shows its exact
 * SQL first, then runs on a short-lived session through the write-safety rules, so a read-only
 * profile refuses it and a production one asks again.
 */

export type DuplicateMode = 'structure-and-data' | 'structure';

/** A script to run: its statements, and whether they run in one transaction (PostgreSQL). */
export interface TableScript {
  readonly statements: readonly string[];
  readonly transactional: boolean;
}

function qualified(table: Pick<TableLocation, 'schema' | 'name'>, dialect: SqlDialect): string {
  return quoteQualified([table.schema, table.name], dialect);
}

/** Every row deleted; the auto-increment counter (or sequence) keeps its value. */
export function emptyTableSql(table: TableLocation, dialect: SqlDialect): string {
  return `DELETE FROM ${qualified(table, dialect)}`;
}

/**
 * Every row removed at once and the counter started over: MySQL and MariaDB reset
 * AUTO_INCREMENT on TRUNCATE; PostgreSQL restarts the identity and serial sequences with
 * RESTART IDENTITY.
 */
export function truncateTableSql(table: TableLocation, dialect: SqlDialect): string {
  const name = qualified(table, dialect);
  return dialect === 'postgres'
    ? `TRUNCATE TABLE ${name} RESTART IDENTITY`
    : `TRUNCATE TABLE ${name}`;
}

/**
 * Copies a table into `copy` in the same schema: CREATE TABLE ... LIKE (columns, defaults, the
 * primary key, unique keys, indexes and checks; never foreign keys or triggers), then, with the
 * data, INSERT ... SELECT of every column the server does not compute. On PostgreSQL the copy's
 * identity columns get their own sequences, moved past the copied values, all in one
 * transaction. Without `live` (the table's definition), the rows are copied with SELECT *.
 */
export function duplicateTableScript(
  source: TableLocation,
  copy: string,
  dialect: SqlDialect,
  mode: DuplicateMode,
  live?: TableDef,
): TableScript {
  const pg = dialect === 'postgres';
  const from = qualified(source, dialect);
  const to = qualified({ schema: source.schema, name: copy }, dialect);
  const statements = [
    pg ? `CREATE TABLE ${to} (LIKE ${from} INCLUDING ALL)` : `CREATE TABLE ${to} LIKE ${from}`,
  ];
  if (mode === 'structure-and-data') {
    const columns = [...(live?.columns ?? [])]
      .filter((column) => column.generated === undefined)
      .sort((a, b) => a.ordinal - b.ordinal);
    // An identity column GENERATED ALWAYS takes the copied value only when told to.
    const overriding =
      pg && columns.some((column) => column.identity?.generation === 'always')
        ? ' OVERRIDING SYSTEM VALUE'
        : '';
    if (columns.length > 0) {
      const list = columns.map((column) => quoteIdent(column.name, dialect)).join(', ');
      statements.push(`INSERT INTO ${to} (${list})${overriding} SELECT ${list} FROM ${from}`);
    } else {
      statements.push(`INSERT INTO ${to}${overriding} SELECT * FROM ${from}`);
    }
    if (pg) {
      for (const column of columns.filter((c) => c.identity !== undefined)) {
        const name = quoteIdent(column.name, dialect);
        statements.push(
          `SELECT setval(pg_get_serial_sequence(${quoteString(to, dialect)}, ${quoteString(column.name, dialect)}), MAX(${name})) FROM ${to} HAVING MAX(${name}) IS NOT NULL`,
        );
      }
    }
  }
  return pg
    ? { statements: ['BEGIN', ...statements, 'COMMIT'], transactional: true }
    : { statements, transactional: false };
}

/** The script as it shows in a review: statements with their terminators. */
export function scriptText(script: TableScript, dialect: SqlDialect): string {
  return formatStatements(script.statements, dialect);
}

/** Why `name` cannot be the copy's name, or undefined when it can. */
export function copyNameIssue(
  name: string,
  dialect: SqlDialect,
  taken: readonly string[],
): string | undefined {
  if (name.trim() === '') return 'Name the copy';
  if (name !== name.trim()) return 'The name starts or ends with a space';
  const limit = dialect === 'postgres' ? 63 : 64;
  const length = dialect === 'postgres' ? new TextEncoder().encode(name).length : [...name].length;
  if (length > limit) {
    return `The name is longer than ${limit} ${dialect === 'postgres' ? 'bytes' : 'characters'}`;
  }
  const lower = name.toLowerCase();
  // MySQL and MariaDB on macOS and Windows compare table names without case: stay on the safe side.
  if (
    taken.some((other) => (dialect === 'postgres' ? other === name : other.toLowerCase() === lower))
  ) {
    return `A table or view named ${name} already exists`;
  }
  return undefined;
}

/** The tables and views of the table's schema (to name a copy), from the metadata cache. */
async function schemaNames(profileId: string, table: TableLocation, dialect: SqlDialect) {
  const snapshot = await loadSnapshot(profileId, { dialect, database: table.database });
  const home =
    snapshot.schemas.find((schema) => schema.name === table.schema) ??
    (dialect === 'postgres' ? undefined : snapshot.schemas[0]);
  return {
    live: findTable(snapshot, table.schema, table.name),
    taken: [...(home?.tables ?? []), ...(home?.views ?? [])].map((object) => object.name),
  };
}

/** Runs a reviewed script on a short-lived session in the table's database. */
async function runTableScript(
  profile: StoredProfile,
  dialect: SqlDialect,
  table: TableLocation,
  script: TableScript,
): Promise<ScriptOutcome> {
  const lane = new SessionLane(profile.id, table.database);
  try {
    return await runScript(lane, profile, dialect, script.statements, script.transactional);
  } catch (error) {
    return { ok: false, cancelled: false, message: errorMessage(error) };
  } finally {
    await lane.close();
  }
}

/** The explorer's tables folder shows the new counts (and a copy) once the change is in. */
function refreshTables(profileId: string, table: TableLocation, dialect: SqlDialect): void {
  void loadChildren(profileId, tablesFolderPath(table, dialect));
}

/**
 * Empties or truncates a table after showing the statement, then reloads its open data views
 * (those without staged changes) and the explorer's row counts.
 */
export async function clearTable(
  profile: StoredProfile,
  table: TableLocation,
  how: 'empty' | 'truncate',
): Promise<void> {
  if (!isSqlEngine(profile.engine)) return;
  const dialect = profile.engine;
  const sql = how === 'empty' ? emptyTableSql(table, dialect) : truncateTableSql(table, dialect);
  const ok = await confirm({
    title: `${how === 'empty' ? 'Empty' : 'Truncate'} table ${table.name}?`,
    message:
      how === 'empty'
        ? 'Every row is deleted; the auto-increment counter keeps its value. This runs:'
        : 'Every row is removed and the auto-increment counter starts over. This runs:',
    detail: scriptText({ statements: [sql], transactional: false }, dialect),
    confirmLabel: how === 'empty' ? 'Empty' : 'Truncate',
    danger: true,
  });
  if (!ok) return;
  const outcome = await runTableScript(profile, dialect, table, {
    statements: [sql],
    transactional: false,
  });
  if (!outcome.ok) {
    if (!outcome.cancelled)
      toastError(outcome.message, { title: `${profile.name}: ${table.name}` });
    return;
  }
  for (const view of tableViewsOf({ profileId: profile.id, ...table })) {
    if (view.changes.getSnapshot().isEmpty) void view.reload();
  }
  refreshTables(profile.id, table, dialect);
}

/** The Duplicate Table dialog: the table, the copy's name being typed, and the script. */
export interface DuplicateRequest {
  readonly profile: StoredProfile;
  readonly dialect: SqlDialect;
  readonly table: TableLocation;
  readonly mode: DuplicateMode;
  /** Loading the table's definition and the names taken in its schema. */
  readonly loading: boolean;
  readonly live: TableDef | undefined;
  readonly taken: readonly string[];
  /** The name the dialog starts with: orders_copy, or orders_copy_2 and on when taken. */
  readonly initial: string;
  readonly running: boolean;
  readonly error: string | undefined;
}

export const useDuplicateRequest = create<{ readonly request: DuplicateRequest | undefined }>()(
  () => ({ request: undefined }),
);

function patchRequest(next: Partial<DuplicateRequest>, table: TableLocation): void {
  const request = useDuplicateRequest.getState().request;
  // A dialog closed (or opened for another table) in the meantime is left alone.
  if (request && request.table === table) {
    useDuplicateRequest.setState({ request: { ...request, ...next } });
  }
}

/** Opens the Duplicate Table dialog, then reads the table and the names in its schema. */
export function openDuplicateTable(
  profile: StoredProfile,
  table: TableLocation,
  mode: DuplicateMode,
): void {
  if (!isSqlEngine(profile.engine)) return;
  const dialect = profile.engine;
  useDuplicateRequest.setState({
    request: {
      profile,
      dialect,
      table,
      mode,
      loading: true,
      live: undefined,
      taken: [],
      initial: copyName(table.name),
      running: false,
      error: undefined,
    },
  });
  schemaNames(profile.id, table, dialect).then(
    ({ live, taken }) =>
      patchRequest({ loading: false, live, taken, initial: copyName(table.name, taken) }, table),
    (error: unknown) => patchRequest({ loading: false, error: errorMessage(error) }, table),
  );
}

export function closeDuplicateTable(): void {
  useDuplicateRequest.setState({ request: undefined });
}

/** Runs the dialog's script for `copy`; the dialog closes once the copy exists. */
export async function submitDuplicateTable(copy: string): Promise<void> {
  const request = useDuplicateRequest.getState().request;
  if (!request || request.running || request.loading) return;
  const { profile, dialect, table } = request;
  const issue = copyNameIssue(copy, dialect, [...request.taken, table.name]);
  if (issue !== undefined) {
    patchRequest({ error: issue }, table);
    return;
  }
  patchRequest({ running: true, error: undefined }, table);
  const outcome = await runTableScript(
    profile,
    dialect,
    table,
    duplicateTableScript(table, copy, dialect, request.mode, request.live),
  );
  if (!outcome.ok) {
    patchRequest({ running: false, error: outcome.cancelled ? undefined : outcome.message }, table);
    return;
  }
  closeDuplicateTable();
  invalidateMetadata(profile.id);
  refreshTables(profile.id, table, dialect);
}
