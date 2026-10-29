import type { StoredProfile } from '@querybara/ipc';

import { openBackupDialog, openRestoreDialog } from '../../state/backup/dialogs';
import { registerCommands } from '../../state/commands';
import { connectedProfiles } from '../../state/connection-context';
import { openErDiagram } from '../../state/er-diagram/panels';
import { openNewDatabase } from '../../state/new-database';
import { openQueryBuilder } from '../../state/query-builder/panels';
import { openServerTools, type ServerToolsTab } from '../../state/server-tools/panels';
import {
  isSqlProfile,
  pickSqlDatabase,
  pickSqlSchema,
  pickSqlTable,
  resolveSqlContext,
  tablesPathOf,
  type SqlContext,
} from '../../state/sql-context';
import { openDataCompare, openStructureCompare } from '../../state/sync/panels';
import { openTransferFrom } from '../../state/transfer-db/api';
import { openExportTables, openImportWizard, openRunSqlFile } from '../../state/transfer-dialogs';
import { openQueryTab, openTableData, openTableDesigner } from '../dock';

/**
 * The SQL toolbar's commands (ADR 0042), for PostgreSQL, MySQL and MariaDB: what the explorer's
 * menus open, on the connection, database, schema and table in front (state/sql-context.ts),
 * asking for whatever is not in front. They show in the palette too, under "SQL".
 */

const anySql = (): boolean => connectedProfiles(isSqlProfile).length > 0;

const anyWritableSql = (): boolean =>
  connectedProfiles((profile) => isSqlProfile(profile) && !profile.presentation.readOnly).length >
  0;

/** Runs `action` on the SQL context in front (asking for the connection when several are open). */
async function withContext(action: (context: SqlContext) => Promise<void> | void): Promise<void> {
  const context = await resolveSqlContext();
  if (context) await action(context);
}

/** Where a context's database (and PostgreSQL schema) sit, for the openers that take them. */
function placeOf(context: SqlContext, database: string): { database: string; schema?: string } {
  return context.dialect === 'postgres' && context.database === database && context.schema
    ? { database, schema: context.schema }
    : { database };
}

function serverTool(profile: StoredProfile, tab: ServerToolsTab, context: SqlContext): void {
  const focus =
    context.database !== undefined
      ? {
          database: context.database,
          ...(context.schema !== undefined ? { container: context.schema } : {}),
          ...(context.table !== undefined ? { name: context.table } : {}),
        }
      : undefined;
  openServerTools(profile, { tab, ...(focus ? { focus } : {}) });
}

const SERVER_TABS: readonly {
  tab: ServerToolsTab;
  id: string;
  title: string;
  icon: 'gauge' | 'pulse' | 'chart' | 'users' | 'wrench';
}[] = [
  { tab: 'monitor', id: 'sql.serverMonitor', title: 'Server Monitor', icon: 'gauge' },
  { tab: 'sessions', id: 'sql.sessions', title: 'Sessions', icon: 'pulse' },
  { tab: 'topQueries', id: 'sql.topQueries', title: 'Top Queries', icon: 'chart' },
  { tab: 'users', id: 'sql.users', title: 'Users and Roles', icon: 'users' },
  { tab: 'maintenance', id: 'sql.maintenance', title: 'Maintenance', icon: 'wrench' },
];

export function registerSqlCommands(): () => void {
  return registerCommands([
    {
      id: 'sql.newQuery',
      category: 'SQL',
      title: 'New SQL Query',
      icon: 'query',
      keywords: ['query', 'editor', 'select'],
      enabled: anySql,
      run: () =>
        withContext((context) => {
          openQueryTab({
            profileId: context.profile.id,
            title: `${context.database ?? context.profile.name} query`,
            ...(context.database !== undefined ? { database: context.database } : {}),
          });
        }),
    },
    {
      id: 'sql.queryBuilder',
      category: 'SQL',
      title: 'Open Query Builder',
      icon: 'builder',
      keywords: ['visual', 'builder', 'join'],
      enabled: anySql,
      run: () =>
        withContext((context) => {
          openQueryBuilder({
            profileId: context.profile.id,
            ...(context.database !== undefined ? placeOf(context, context.database) : {}),
          });
        }),
    },
    {
      id: 'sql.runSqlFile',
      category: 'SQL',
      title: 'Run SQL File…',
      icon: 'file-run',
      keywords: ['script', 'execute', 'file'],
      enabled: anySql,
      run: () =>
        withContext((context) => {
          openRunSqlFile(context.profile, context.database);
        }),
    },
    {
      id: 'sql.openTable',
      category: 'SQL',
      title: 'Open Table…',
      icon: 'table',
      keywords: ['rows', 'data', 'browse'],
      enabled: anySql,
      run: () =>
        withContext(async (context) => {
          const table = await pickSqlTable(context);
          if (!table || table.name === null) return;
          openTableData({
            profileId: context.profile.id,
            database: table.database,
            schema: table.schema,
            name: table.name,
          });
        }),
    },
    {
      id: 'sql.newTable',
      category: 'SQL',
      title: 'New Table…',
      icon: 'table-new',
      keywords: ['create', 'designer'],
      enabled: anyWritableSql,
      run: () =>
        withContext(async (context) => {
          const location = await pickSqlSchema(context);
          if (!location) return;
          openTableDesigner({
            profileId: context.profile.id,
            database: location.database,
            schema: location.schema,
            name: null,
            tablesPath: tablesPathOf(location, context.dialect),
          });
        }),
    },
    {
      id: 'sql.newDatabase',
      category: 'SQL',
      title: 'New Database…',
      icon: 'database',
      keywords: ['create', 'schema'],
      enabled: anyWritableSql,
      run: () =>
        withContext((context) => {
          if (!context.profile.presentation.readOnly) openNewDatabase(context.profile);
        }),
    },
    {
      id: 'sql.erDiagram',
      category: 'SQL',
      title: 'ER Diagram',
      icon: 'diagram',
      keywords: ['entity', 'relationship', 'model', 'foreign keys'],
      enabled: anySql,
      run: () =>
        withContext((context) => {
          openErDiagram({
            profileId: context.profile.id,
            ...(context.database !== undefined ? placeOf(context, context.database) : {}),
          });
        }),
    },
    {
      id: 'sql.import',
      category: 'SQL',
      title: 'Import Data…',
      icon: 'import',
      keywords: ['csv', 'excel', 'json', 'load'],
      enabled: anyWritableSql,
      run: () =>
        withContext(async (context) => {
          const table = await pickSqlTable(context, { orNew: true });
          if (!table) return;
          openImportWizard(context.profile, table, table.name);
        }),
    },
    {
      id: 'sql.export',
      category: 'SQL',
      title: 'Export Tables…',
      icon: 'export',
      keywords: ['csv', 'excel', 'json', 'dump'],
      enabled: anySql,
      run: () =>
        withContext(async (context) => {
          const location = await pickSqlSchema(context);
          if (!location) return;
          const selected =
            context.table !== undefined &&
            context.database === location.database &&
            context.schema === location.schema
              ? [context.table]
              : [];
          openExportTables(
            context.profile,
            location,
            selected,
            tablesPathOf(location, context.dialect),
          );
        }),
    },
    {
      id: 'sql.transfer',
      category: 'SQL',
      title: 'Transfer Data To…',
      icon: 'transfer',
      keywords: ['copy', 'migrate', 'move'],
      enabled: anySql,
      run: () =>
        withContext((context) => {
          openTransferFrom(context.profile, {
            ...(context.database !== undefined ? { database: context.database } : {}),
            ...(context.schema !== undefined ? { schema: context.schema } : {}),
            ...(context.table !== undefined ? { objects: [context.table] } : {}),
          });
        }),
    },
    {
      id: 'sql.backup',
      category: 'SQL',
      title: 'Back Up…',
      icon: 'archive',
      keywords: ['backup', 'dump', 'archive'],
      enabled: anySql,
      run: () =>
        withContext((context) => {
          openBackupDialog(context.profile, {
            ...(context.database !== undefined ? { database: context.database } : {}),
            ...(context.dialect === 'postgres' && context.schema !== undefined
              ? { schema: context.schema }
              : {}),
          });
        }),
    },
    {
      id: 'sql.restore',
      category: 'SQL',
      title: 'Restore…',
      icon: 'restore',
      keywords: ['backup', 'archive', 'load'],
      enabled: anyWritableSql,
      run: () =>
        withContext((context) => {
          if (context.profile.presentation.readOnly) return;
          openRestoreDialog(
            context.profile,
            context.database !== undefined ? { database: context.database } : undefined,
          );
        }),
    },
    {
      id: 'sql.compareStructure',
      category: 'SQL',
      title: 'Compare Structure With…',
      icon: 'compare',
      keywords: ['schema', 'sync', 'diff', 'migrate'],
      enabled: anySql,
      run: () =>
        withContext(async (context) => {
          const database = await pickSqlDatabase(context);
          if (database === undefined) return;
          const place = placeOf(context, database);
          openStructureCompare({
            source: {
              profileId: context.profile.id,
              database,
              ...(place.schema !== undefined ? { schemas: place.schema } : {}),
            },
          });
        }),
    },
    {
      id: 'sql.compareData',
      category: 'SQL',
      title: 'Compare Data With…',
      icon: 'compare-rows',
      keywords: ['rows', 'sync', 'diff'],
      enabled: anySql,
      run: () =>
        withContext(async (context) => {
          const database = await pickSqlDatabase(context);
          if (database === undefined) return;
          const place = placeOf(context, database);
          openDataCompare({
            source: {
              profileId: context.profile.id,
              database,
              ...(place.schema !== undefined ? { schemas: place.schema } : {}),
            },
          });
        }),
    },
    ...SERVER_TABS.map(({ tab, id, title, icon }) => ({
      id,
      category: 'SQL',
      title,
      icon,
      keywords: ['server', 'tools', tab],
      enabled: anySql,
      run: () => withContext((context) => serverTool(context.profile, tab, context)),
    })),
  ]);
}
