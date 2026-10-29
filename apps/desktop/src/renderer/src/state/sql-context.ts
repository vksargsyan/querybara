import { isSqlEngine, type SqlDialect } from '@querybara/core';
import type { StoredProfile } from '@querybara/ipc';

import { resolveProfile } from './connection-context';
import { loadChildren, pathKey, useExplorer } from './explorer';
import { useObjectsView } from './objects-location';
import { quickPick } from './palette';
import { getTableView } from './table-view';
import { useWorkspace } from './workspace';

/**
 * What the SQL toolbar and its commands act on (ADR 0042), as the MongoDB ones do (ADR 0036):
 * the active tab's connection with its database (a query tab's), schema and table (a table's
 * data view), else the database, schema or table under the node last picked in the side bar,
 * else the connection in front. Where that leaves a database, schema or table unnamed, the
 * pickers ask, from the explorer's own lists.
 */

export interface SqlContext {
  readonly profile: StoredProfile;
  readonly dialect: SqlDialect;
  readonly database?: string;
  /** A PostgreSQL schema; the database on MySQL and MariaDB. */
  readonly schema?: string;
  readonly table?: string;
}

/** A schema to work in: a PostgreSQL database and schema, or a MySQL/MariaDB database twice. */
export interface SqlSchemaLocation {
  readonly database: string;
  readonly schema: string;
}

export const isSqlProfile = (profile: StoredProfile): boolean => isSqlEngine(profile.engine);

function dialectOf(profile: StoredProfile): SqlDialect | undefined {
  return isSqlEngine(profile.engine) ? profile.engine : undefined;
}

/** The database, schema and table an explorer path (database / [schema /] folder / object) names. */
export function sqlPlace(
  path: readonly string[],
  dialect: SqlDialect,
): Pick<SqlContext, 'database' | 'schema' | 'table'> {
  const [database, second, third, fourth] = path;
  if (database === undefined) return {};
  if (dialect === 'postgres') {
    if (second === undefined) return { database };
    const table = third === 'tables' ? fourth : undefined;
    return { database, schema: second, ...(table !== undefined ? { table } : {}) };
  }
  const table = second === 'tables' ? third : undefined;
  return { database, schema: database, ...(table !== undefined ? { table } : {}) };
}

/** The place the active tab works on, when it is one of this connection's. */
function activeTabPlace(
  profileId: string,
  dialect: SqlDialect,
): Omit<SqlContext, 'profile' | 'dialect'> {
  const id = useWorkspace.getState().activeTabId;
  if (id === undefined) return {};
  const tab = useWorkspace.getState().tabs[id];
  if (tab?.profileId === profileId) {
    const database = tab.database;
    if (database === undefined) return {};
    return dialect === 'postgres' ? { database } : { database, schema: database };
  }
  const view = getTableView(id);
  if (view?.target.profileId === profileId) {
    const { target } = view;
    const database = dialect === 'postgres' ? target.database : target.schema;
    return {
      ...(database !== undefined ? { database } : {}),
      schema: target.schema,
      table: target.name,
    };
  }
  return {};
}

/** The SQL context of a connection now (from the active tab, else the side bar). */
export function sqlContextOf(profile: StoredProfile): SqlContext | undefined {
  const dialect = dialectOf(profile);
  if (!dialect) return undefined;
  const fromTab = activeTabPlace(profile.id, dialect);
  if (fromTab.database !== undefined) return { profile, dialect, ...fromTab };
  const location = useObjectsView.getState().location;
  if (location?.profileId === profile.id) {
    return { profile, dialect, ...sqlPlace(location.source, dialect) };
  }
  return { profile, dialect };
}

/** The SQL context to act on, asking for the connection when several are open. */
export async function resolveSqlContext(): Promise<SqlContext | undefined> {
  const profile = await resolveProfile(isSqlProfile, 'Which SQL connection?');
  return profile ? sqlContextOf(profile) : undefined;
}

async function childNames(
  profileId: string,
  path: readonly string[],
  kind: string,
): Promise<string[]> {
  await loadChildren(profileId, path);
  const nodes = useExplorer.getState().children[profileId]?.[pathKey(path)]?.nodes ?? [];
  return nodes.filter((node) => node.kind === kind).map((node) => node.name);
}

/** The context's database, asking for one when it has none. */
export async function pickSqlDatabase(context: SqlContext): Promise<string | undefined> {
  if (context.database !== undefined) return context.database;
  const names = await childNames(context.profile.id, [], 'database');
  return quickPick({
    placeholder: `Which database of ${context.profile.name}?`,
    items: names.map((name) => ({ label: name, icon: 'database' as const, value: name })),
  });
}

/** The context's schema (a MySQL/MariaDB database), asking for what it lacks. */
export async function pickSqlSchema(context: SqlContext): Promise<SqlSchemaLocation | undefined> {
  const database = await pickSqlDatabase(context);
  if (database === undefined) return undefined;
  if (context.dialect !== 'postgres') return { database, schema: database };
  if (context.schema !== undefined && context.database === database) {
    return { database, schema: context.schema };
  }
  const names = await childNames(context.profile.id, [database], 'schema');
  const schema = await quickPick({
    placeholder: `Which schema of ${database}?`,
    items: names.map((name) => ({ label: name, icon: 'folder' as const, value: name })),
  });
  return schema === undefined ? undefined : { database, schema };
}

/** The explorer folder of a schema's tables. */
export function tablesPathOf(location: SqlSchemaLocation, dialect: SqlDialect): string[] {
  return dialect === 'postgres'
    ? [location.database, location.schema, 'tables']
    : [location.database, 'tables'];
}

/**
 * The context's table, asking for one in its schema when it has none. With `orNew`, the list
 * also offers a new table, which comes back as `name: null`.
 */
export async function pickSqlTable(
  context: SqlContext,
  options: { readonly orNew?: boolean } = {},
): Promise<(SqlSchemaLocation & { readonly name: string | null }) | undefined> {
  const location = await pickSqlSchema(context);
  if (!location) return undefined;
  if (
    context.table !== undefined &&
    context.database === location.database &&
    context.schema === location.schema
  ) {
    return { ...location, name: context.table };
  }
  const names = await childNames(
    context.profile.id,
    tablesPathOf(location, context.dialect),
    'table',
  );
  const NEW = '\u0000new';
  const picked = await quickPick({
    placeholder: `Which table of ${context.dialect === 'postgres' ? `${location.database}.${location.schema}` : location.database}?`,
    items: [
      ...(options.orNew ? [{ label: 'New table…', icon: 'table-new' as const, value: NEW }] : []),
      ...names.map((name) => ({ label: name, icon: 'table' as const, value: name })),
    ],
  });
  if (picked === undefined) return undefined;
  return { ...location, name: picked === NEW ? null : picked };
}
