import { create } from 'zustand';

import { registerCommands, showStatus } from '../../state/commands';
import {
  activeCollectionView,
  activeIntelliShell,
  activeMongoPanel,
  connectedMongo,
  mongoContext,
  pickCollection,
  pickDatabase,
  resolveMongoContext,
  type MongoContext,
} from '../../state/mongo/context';
import { defaultShellScript } from '../../state/mongo/explorer';
import { openMongoExport, openMongoImport } from '../../state/mongo/file-transfer';
import type { ResultMode } from '../../state/mongo/results';
import { openServerTools } from '../../state/server-tools/panels';
import { openStructureCompare } from '../../state/sync/panels';
import { openTransferFrom } from '../../state/transfer-db/api';
import { openIntelliShell, openMongoCollection, openMongoSql, openMongoTool } from './open';

/**
 * The MongoDB commands (ADR 0036): what Studio 3T's toolbar, menus and keys do, on the
 * connection, database and collection in view (state/mongo/context.ts). Their default keys are
 * Studio 3T's: Ctrl+L IntelliShell, Ctrl+Shift+L SQL, F4 the Aggregation Editor, Ctrl+Alt+1/2/3
 * the Tree, Table and JSON views, Ctrl+D insert, Ctrl+U the update dialog, F8 the delete dialog,
 * Ctrl+G Query Code, Ctrl+Alt+B the toolbar.
 */

/** Whether the MongoDB toolbar shows (a convenience kept in this browser profile). */
export const useMongoToolbar = create<{ readonly visible: boolean }>()(() => ({
  visible: readVisible(),
}));

const TOOLBAR_KEY = 'querybara.mongoToolbar';

function readVisible(): boolean {
  try {
    return localStorage.getItem(TOOLBAR_KEY) !== 'hidden';
  } catch {
    return true;
  }
}

export function setMongoToolbar(visible: boolean): void {
  useMongoToolbar.setState({ visible });
  try {
    localStorage.setItem(TOOLBAR_KEY, visible ? 'shown' : 'hidden');
  } catch {
    // Not kept: the next window shows it.
  }
}

const anyMongo = (): boolean => connectedMongo().length > 0;

/** Runs `action` on the context's collection, asking for one when none is in view. */
async function onCollection(
  action: (
    context: MongoContext,
    target: { db: string; collection: string; kind: NonNullable<MongoContext['kind']> },
  ) => void,
): Promise<void> {
  const context = await resolveMongoContext();
  if (!context) return;
  const target = await pickCollection(context);
  if (target) action(context, target);
}

/** Runs `action` on the context's database, asking for one when none is in view. */
async function onDatabase(action: (context: MongoContext, db: string) => void): Promise<void> {
  const context = await resolveMongoContext();
  if (!context) return;
  const db = await pickDatabase(context);
  if (db !== undefined) action(context, db);
}

function setView(mode: ResultMode): void {
  const view = activeCollectionView();
  if (view) {
    view.setView(mode);
    return;
  }
  activeIntelliShell()?.setMode(mode);
}

const hasResults = (): boolean =>
  activeCollectionView() !== undefined || activeIntelliShell() !== undefined;

const writableView = (): boolean => activeCollectionView()?.writable === true;

export function registerMongoCommands(): () => void {
  return registerCommands([
    {
      id: 'mongo.openCollection',
      category: 'MongoDB',
      title: 'Open Collection Tab',
      icon: 'table',
      keywords: ['studio 3t', 'documents', 'collection'],
      enabled: anyMongo,
      run: () =>
        onCollection((context, target) =>
          openMongoCollection({ profileId: context.profile.id, ...target }),
        ),
    },
    {
      id: 'mongo.openIntelliShell',
      category: 'MongoDB',
      title: 'Open IntelliShell',
      icon: 'shell',
      keywords: ['mongosh', 'shell', 'console', 'script'],
      enabled: anyMongo,
      run: async () => {
        const context = await resolveMongoContext();
        if (!context) return;
        openIntelliShell({
          profileId: context.profile.id,
          ...(context.db !== undefined ? { database: context.db } : {}),
          ...(context.collection !== undefined
            ? { text: defaultShellScript(context.collection) }
            : {}),
        });
      },
    },
    {
      id: 'mongo.openSql',
      category: 'MongoDB',
      title: 'Open SQL Query',
      icon: 'query',
      keywords: ['sql', 'select'],
      enabled: anyMongo,
      run: () =>
        onDatabase((context, db) =>
          openMongoSql({
            profileId: context.profile.id,
            db,
            ...(context.collection !== undefined && context.db === db
              ? { collection: context.collection }
              : {}),
          }),
        ),
    },
    {
      id: 'mongo.openAggregation',
      category: 'MongoDB',
      title: 'Open Aggregation Editor',
      icon: 'filter',
      keywords: ['aggregate', 'pipeline'],
      enabled: anyMongo,
      run: () =>
        onCollection((context, { db, collection }) =>
          openMongoTool({
            tool: 'aggregation',
            target: { profileId: context.profile.id, db, collection },
          }),
        ),
    },
    {
      id: 'mongo.analyzeSchema',
      category: 'MongoDB',
      title: 'Analyze Schema…',
      icon: 'chart',
      enabled: anyMongo,
      run: () =>
        onCollection((context, { db, collection, kind }) =>
          openMongoTool({
            tool: 'schema',
            target: { profileId: context.profile.id, db, collection, kind },
          }),
        ),
    },
    {
      id: 'mongo.manageIndexes',
      category: 'MongoDB',
      title: 'Manage Indexes',
      icon: 'key',
      enabled: anyMongo,
      run: () =>
        onCollection((context, { db, collection }) =>
          openMongoTool({
            tool: 'indexes',
            target: { profileId: context.profile.id, db, collection },
          }),
        ),
    },
    {
      id: 'mongo.manageUsers',
      category: 'MongoDB',
      title: 'Manage Users',
      icon: 'users',
      enabled: anyMongo,
      run: () =>
        onDatabase((context, db) =>
          openMongoTool({
            tool: 'users',
            target: { profileId: context.profile.id, db, tab: 'users' },
          }),
        ),
    },
    {
      id: 'mongo.manageRoles',
      category: 'MongoDB',
      title: 'Manage Roles',
      icon: 'users',
      enabled: anyMongo,
      run: () =>
        onDatabase((context, db) =>
          openMongoTool({
            tool: 'users',
            target: { profileId: context.profile.id, db, tab: 'roles' },
          }),
        ),
    },
    {
      id: 'mongo.compare',
      category: 'MongoDB',
      title: 'Compare To…',
      icon: 'compare',
      enabled: anyMongo,
      run: () =>
        onDatabase((context, db) =>
          openStructureCompare({ source: { profileId: context.profile.id, database: db } }),
        ),
    },
    {
      id: 'mongo.transfer',
      category: 'MongoDB',
      title: 'Transfer Data To…',
      icon: 'transfer',
      keywords: ['migration', 'sql', 'copy'],
      enabled: anyMongo,
      run: () =>
        onDatabase((context, db) =>
          openTransferFrom(context.profile, {
            database: db,
            ...(context.collection !== undefined && context.db === db
              ? { objects: [context.collection] }
              : {}),
          }),
        ),
    },
    {
      id: 'mongo.export',
      category: 'MongoDB',
      title: 'Export…',
      icon: 'export',
      keywords: ['json', 'csv', 'bson', 'mongoexport', 'file'],
      enabled: anyMongo,
      run: async () => {
        const view = activeCollectionView();
        if (view) {
          void openMongoExport(view.fileExport());
          return;
        }
        await onDatabase(
          (context, db) =>
            void openMongoExport({
              profileId: context.profile.id,
              db,
              ...(context.collection !== undefined && context.db === db
                ? { collections: [context.collection] }
                : {}),
            }),
        );
      },
    },
    {
      id: 'mongo.import',
      category: 'MongoDB',
      title: 'Import…',
      icon: 'import',
      keywords: ['json', 'csv', 'bson', 'mongoimport', 'file'],
      enabled: anyMongo,
      run: () =>
        onDatabase(
          (context, db) =>
            void openMongoImport({
              profileId: context.profile.id,
              db,
              ...(context.collection !== undefined && context.db === db && context.kind !== 'view'
                ? { collection: context.collection }
                : {}),
            }),
        ),
    },
    {
      id: 'mongo.serverStatus',
      category: 'MongoDB',
      title: 'Server Status',
      icon: 'gauge',
      enabled: anyMongo,
      run: async () => {
        const context = await resolveMongoContext();
        if (context) openServerTools(context.profile, { tab: 'monitor' });
      },
    },
    {
      id: 'mongo.currentOperations',
      category: 'MongoDB',
      title: 'Current Operations',
      icon: 'pulse',
      enabled: anyMongo,
      run: async () => {
        const context = await resolveMongoContext();
        if (context) openServerTools(context.profile, { tab: 'sessions' });
      },
    },
    {
      id: 'mongo.profiler',
      category: 'MongoDB',
      title: 'Query Profiler',
      icon: 'history',
      enabled: anyMongo,
      run: async () => {
        const context = await resolveMongoContext();
        if (!context) return;
        openServerTools(context.profile, {
          tab: 'topQueries',
          ...(context.db !== undefined ? { focus: { container: context.db } } : {}),
        });
      },
    },
    {
      id: 'mongo.view.tree',
      category: 'MongoDB',
      title: 'Tree View',
      icon: 'view-tree',
      enabled: hasResults,
      run: () => setView('tree'),
    },
    {
      id: 'mongo.view.table',
      category: 'MongoDB',
      title: 'Table View',
      icon: 'view-grid',
      enabled: hasResults,
      run: () => setView('table'),
    },
    {
      id: 'mongo.view.json',
      category: 'MongoDB',
      title: 'JSON View',
      icon: 'view-json',
      enabled: hasResults,
      run: () => setView('json'),
    },
    {
      id: 'mongo.insertDocument',
      category: 'MongoDB',
      title: 'Insert Document…',
      icon: 'plus',
      enabled: writableView,
      run: () => activeCollectionView()?.openEditor('insert'),
    },
    {
      id: 'mongo.updateDialog',
      category: 'MongoDB',
      title: 'Update Dialog…',
      icon: 'edit',
      enabled: writableView,
      run: () => activeCollectionView()?.openBulk('update'),
    },
    {
      id: 'mongo.deleteDialog',
      category: 'MongoDB',
      title: 'Delete Dialog…',
      icon: 'trash',
      enabled: writableView,
      run: () => activeCollectionView()?.openBulk('delete'),
    },
    {
      id: 'mongo.queryCode',
      category: 'MongoDB',
      title: 'Query Code',
      icon: 'export',
      keywords: ['export code', 'node', 'python', 'java'],
      enabled: () => activeCollectionView() !== undefined,
      run: () => activeCollectionView()?.setSection('code'),
    },
    {
      id: 'mongo.toggleQueryBuilder',
      category: 'MongoDB',
      title: 'Toggle Visual Query Builder',
      icon: 'builder',
      enabled: () => activeCollectionView() !== undefined,
      run: () => {
        const view = activeCollectionView();
        if (!view) return;
        view.builder.setMode(view.builder.state.mode === 'builder' ? 'fields' : 'builder');
      },
    },
    {
      id: 'view.toggleMongoToolbar',
      category: 'View',
      title: 'Toggle MongoDB Toolbar',
      icon: 'wrench',
      keywords: ['studio 3t', 'toolbar'],
      run: () => {
        const visible = !useMongoToolbar.getState().visible;
        setMongoToolbar(visible);
        if (visible && !anyMongo()) {
          showStatus('info', 'The MongoDB toolbar shows while a MongoDB connection is open.', 3000);
        }
      },
    },
  ]);
}

/** Whether the active panel is a MongoDB one (the toolbar's context marker). */
export function mongoInView(): boolean {
  return activeMongoPanel() !== undefined || mongoContext() !== undefined;
}
