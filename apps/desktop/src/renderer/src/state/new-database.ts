import { isSqlEngine, type SqlDialect } from '@querybara/core';
import type { StoredProfile } from '@querybara/ipc';
import { quoteIdent, quoteString } from '@querybara/sql-tools';
import { create } from 'zustand';

import { errorMessage } from '../lib/errors';
import { runScript, type ScriptOutcome } from './designer';
import { refreshObjects } from './metadata';
import { collect, type SessionLane } from './session-lane';

/**
 * The "New database…" dialog of a SQL connection (MySQL, MariaDB, PostgreSQL): a name and the
 * options the engine takes, the CREATE DATABASE statement it builds, and the run, with the
 * connection's write-safety checks, that reloads the side bar's list of databases.
 */

export interface NewDatabaseForm {
  readonly name: string;
  /** MySQL and MariaDB: '' for the server's default. */
  readonly charset: string;
  /** MySQL and MariaDB: '' for the character set's default. */
  readonly collation: string;
  /** PostgreSQL: '' for the role that runs the statement. */
  readonly owner: string;
  /** PostgreSQL: '' for the template's encoding. */
  readonly encoding: string;
  /** PostgreSQL: '' for template1. */
  readonly template: string;
}

export const EMPTY_DATABASE_FORM: NewDatabaseForm = {
  name: '',
  charset: '',
  collation: '',
  owner: '',
  encoding: '',
  template: '',
};

/** What the server offers the form: its databases, and the options' choices. */
export interface DatabaseChoices {
  readonly existing: readonly string[];
  /** MySQL and MariaDB. */
  readonly charsets: readonly { readonly name: string; readonly defaultCollation: string }[];
  readonly collations: readonly { readonly name: string; readonly charset: string }[];
  readonly serverCharset: string | undefined;
  /** PostgreSQL. */
  readonly roles: readonly string[];
  readonly templates: readonly string[];
}

export const NO_CHOICES: DatabaseChoices = {
  existing: [],
  charsets: [],
  collations: [],
  serverCharset: undefined,
  roles: [],
  templates: [],
};

/** The encodings a PostgreSQL server can store (the client-only ones left out). */
export const POSTGRES_ENCODINGS: readonly string[] = [
  'UTF8',
  'SQL_ASCII',
  'EUC_CN',
  'EUC_JP',
  'EUC_JIS_2004',
  'EUC_KR',
  'EUC_TW',
  'ISO_8859_5',
  'ISO_8859_6',
  'ISO_8859_7',
  'ISO_8859_8',
  'KOI8R',
  'KOI8U',
  'LATIN1',
  'LATIN2',
  'LATIN3',
  'LATIN4',
  'LATIN5',
  'LATIN6',
  'LATIN7',
  'LATIN8',
  'LATIN9',
  'LATIN10',
  'MULE_INTERNAL',
  'WIN866',
  'WIN874',
  'WIN1250',
  'WIN1251',
  'WIN1252',
  'WIN1253',
  'WIN1254',
  'WIN1255',
  'WIN1256',
  'WIN1257',
  'WIN1258',
];

export type BuiltDatabase =
  | { readonly ok: true; readonly statement: string }
  | { readonly ok: false; readonly issues: Readonly<Record<string, string>> };

const WORD = /^[A-Za-z0-9_]+$/;

/** Why the name cannot be a new database's, if it cannot. */
export function databaseNameIssue(
  name: string,
  dialect: SqlDialect,
  existing: readonly string[] = [],
): string | undefined {
  if (name.trim() === '') return 'Name the database';
  if (name !== name.trim()) return 'The name has leading or trailing spaces';
  if (name.includes('\0')) return 'A database name cannot contain a null character';
  if (dialect === 'postgres') {
    // Longer names are cut to 63 bytes without an error.
    if (new TextEncoder().encode(name).length > 63) return 'At most 63 bytes';
  } else if ([...name].length > 64) return 'At most 64 characters';
  if (existing.includes(name)) return `The database ${name} exists already`;
  return undefined;
}

/** The CREATE DATABASE statement for the form, or why there is none yet. */
export function buildCreateDatabase(
  dialect: SqlDialect,
  form: NewDatabaseForm,
  existing: readonly string[] = [],
): BuiltDatabase {
  const issues: Record<string, string> = {};
  const nameIssue = databaseNameIssue(form.name, dialect, existing);
  if (nameIssue) issues['name'] = nameIssue;
  const clauses: string[] = [];
  if (dialect === 'postgres') {
    if (form.owner !== '') clauses.push(`OWNER ${quoteIdent(form.owner, dialect)}`);
    if (form.template !== '') clauses.push(`TEMPLATE ${quoteIdent(form.template, dialect)}`);
    if (form.encoding !== '') {
      if (WORD.test(form.encoding)) clauses.push(`ENCODING ${quoteString(form.encoding, dialect)}`);
      else issues['encoding'] = 'Not an encoding name';
    }
  } else {
    if (form.charset !== '') {
      if (WORD.test(form.charset)) clauses.push(`CHARACTER SET ${form.charset}`);
      else issues['charset'] = 'Not a character set name';
    }
    if (form.collation !== '') {
      if (WORD.test(form.collation)) clauses.push(`COLLATE ${form.collation}`);
      else issues['collation'] = 'Not a collation name';
    }
  }
  if (Object.keys(issues).length > 0) return { ok: false, issues };
  const head = `CREATE DATABASE ${quoteIdent(form.name, dialect)}`;
  return { ok: true, statement: clauses.length > 0 ? `${head} ${clauses.join(' ')}` : head };
}

/** The form after a change: an encoding picked on template1's default moves to template0. */
export function changeDatabaseForm(
  form: NewDatabaseForm,
  patch: Partial<NewDatabaseForm>,
): NewDatabaseForm {
  const next = { ...form, ...patch };
  // template1 refuses an encoding other than its own; template0 takes any.
  if (patch.encoding !== undefined && patch.encoding !== '' && form.template === '') {
    return { ...next, template: 'template0' };
  }
  // A collation belongs to one character set: a new character set drops the old one.
  if (
    patch.charset !== undefined &&
    patch.charset !== form.charset &&
    patch.collation === undefined
  ) {
    return { ...next, collation: '' };
  }
  return next;
}

async function column(lane: SessionLane, sql: string): Promise<string[]> {
  const result = await lane.run((host, sessionId) => collect(host, sessionId, { sql }));
  return result.rows.map((row) => String(row[0] ?? ''));
}

/** Reads the server's databases and the options' choices; a list it cannot read stays empty. */
export async function loadDatabaseChoices(
  lane: SessionLane,
  dialect: SqlDialect,
): Promise<DatabaseChoices> {
  const read = <T>(task: Promise<T>, fallback: T): Promise<T> => task.catch(() => fallback);
  if (dialect === 'postgres') {
    const [existing, roles, templates] = await Promise.all([
      read(column(lane, 'SELECT datname FROM pg_catalog.pg_database ORDER BY 1'), []),
      read(
        column(lane, "SELECT rolname FROM pg_catalog.pg_roles WHERE rolname !~ '^pg_' ORDER BY 1"),
        [],
      ),
      read(
        column(lane, 'SELECT datname FROM pg_catalog.pg_database WHERE datistemplate ORDER BY 1'),
        [],
      ),
    ]);
    return { ...NO_CHOICES, existing, roles, templates };
  }
  const [existing, charsets, collations, server] = await Promise.all([
    read(column(lane, 'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY 1'), []),
    read(
      lane.run((host, sessionId) =>
        collect(host, sessionId, {
          sql: 'SELECT CHARACTER_SET_NAME, DEFAULT_COLLATE_NAME FROM information_schema.CHARACTER_SETS ORDER BY 1',
        }),
      ),
      undefined,
    ),
    read(
      lane.run((host, sessionId) =>
        collect(host, sessionId, {
          sql: 'SELECT COLLATION_NAME, CHARACTER_SET_NAME FROM information_schema.COLLATIONS WHERE CHARACTER_SET_NAME IS NOT NULL ORDER BY 1',
        }),
      ),
      undefined,
    ),
    read(column(lane, 'SELECT @@character_set_server'), []),
  ]);
  return {
    ...NO_CHOICES,
    existing,
    charsets: (charsets?.rows ?? []).map((row) => ({
      name: String(row[0] ?? ''),
      defaultCollation: String(row[1] ?? ''),
    })),
    collations: (collations?.rows ?? []).map((row) => ({
      name: String(row[0] ?? ''),
      charset: String(row[1] ?? ''),
    })),
    serverCharset: server[0],
  };
}

/** The connection the dialog is open for. */
export const useNewDatabaseRequest = create<{ readonly profile?: StoredProfile }>()(() => ({}));

export function openNewDatabase(profile: StoredProfile): void {
  if (isSqlEngine(profile.engine)) useNewDatabaseRequest.setState({ profile });
}

export function closeNewDatabase(): void {
  useNewDatabaseRequest.setState({ profile: undefined });
}

/** Runs the statement (after the connection's write checks) and reloads the databases. */
export async function createDatabase(
  lane: SessionLane,
  profile: StoredProfile,
  statement: string,
): Promise<ScriptOutcome> {
  if (!isSqlEngine(profile.engine)) {
    return { ok: false, cancelled: false, message: 'Not a SQL connection' };
  }
  try {
    const outcome = await runScript(lane, profile, profile.engine, [statement], false);
    if (outcome.ok) refreshObjects(profile.id, []);
    return outcome;
  } catch (error) {
    return { ok: false, cancelled: false, message: errorMessage(error) };
  }
}
