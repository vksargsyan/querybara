import type { StoredProfile } from '@querybara/ipc';

import { currentDock } from '../../components/dock';
import { useConnections } from '../connections';
import { keys, queryClient } from '../data';
import { loadChildren, pathKey, useExplorer } from '../explorer';
import { useObjectsView } from '../objects-view';
import { panelInfo } from '../panels';
import { quickPick } from '../palette';
import { CollectionView } from './collection-view';
import { IntelliShell } from './intellishell';
import { getMongoPanel, type MongoPanel } from './panels';

/**
 * What the MongoDB toolbar and shortcuts act on (ADR 0036), as Studio 3T's act on the selection:
 * the active tab's connection, database and collection when it is a MongoDB one, else the
 * database or folder last picked in the side bar, else the only MongoDB connection open. Where
 * that leaves a collection or a database unnamed, `pickCollection` and `pickDatabase` ask.
 */

export interface MongoContext {
  readonly profile: StoredProfile;
  readonly db?: string;
  readonly collection?: string;
  readonly kind?: 'collection' | 'view' | 'time-series';
}

function profiles(): StoredProfile[] {
  return queryClient.getQueryData<StoredProfile[]>(keys.profiles) ?? [];
}

function mongoProfile(id: string): StoredProfile | undefined {
  return profiles().find((profile) => profile.id === id && profile.engine === 'mongodb');
}

/** MongoDB connections that are open. */
export function connectedMongo(): StoredProfile[] {
  const byProfile = useConnections.getState().byProfile;
  return profiles().filter(
    (profile) => profile.engine === 'mongodb' && byProfile[profile.id]?.status === 'ready',
  );
}

/** The active dock panel when it is a MongoDB one. */
export function activeMongoPanel(): MongoPanel | undefined {
  const id = currentDock()?.activePanel?.id;
  return id === undefined ? undefined : getMongoPanel(id);
}

/** The active collection tab, if the active panel is one. */
export function activeCollectionView(): CollectionView | undefined {
  const panel = activeMongoPanel();
  return panel instanceof CollectionView ? panel : undefined;
}

/** The active IntelliShell, if the active panel is one. */
export function activeIntelliShell(): IntelliShell | undefined {
  const panel = activeMongoPanel();
  return panel instanceof IntelliShell ? panel : undefined;
}

/** The database and collection a MongoDB panel works on. */
function panelTarget(panel: MongoPanel): { db?: string; collection?: string } {
  if (panel instanceof CollectionView) {
    return { db: panel.target.db, collection: panel.target.collection };
  }
  if (panel instanceof IntelliShell) {
    const db = panel.state.database;
    return db === undefined ? {} : { db };
  }
  const target: unknown = panel.target;
  if (typeof target !== 'object' || target === null) return {};
  const { db, collection } = target as { db?: unknown; collection?: unknown };
  return {
    ...(typeof db === 'string' ? { db } : {}),
    ...(typeof collection === 'string' ? { collection } : {}),
  };
}

const COLLECTION_FOLDERS: Readonly<Record<string, MongoContext['kind']>> = {
  collections: 'collection',
  views: 'view',
  'time-series': 'time-series',
};

export function mongoContext(): MongoContext | undefined {
  const id = currentDock()?.activePanel?.id;
  const info = id === undefined ? undefined : panelInfo(id);
  const fromPanel = info ? mongoProfile(info.profileId) : undefined;
  if (fromPanel && id !== undefined) {
    const panel = getMongoPanel(id);
    if (panel) {
      const target = panelTarget(panel);
      const kind = panel instanceof CollectionView ? panel.target.kind : undefined;
      return { profile: fromPanel, ...target, ...(kind ? { kind } : {}) };
    }
    return { profile: fromPanel, ...(info?.database ? { db: info.database } : {}) };
  }
  const location = useObjectsView.getState().location;
  const fromTree = location ? mongoProfile(location.profileId) : undefined;
  if (fromTree && location) {
    const [db, folder, collection] = location.source;
    const kind = folder === undefined ? undefined : COLLECTION_FOLDERS[folder];
    return {
      profile: fromTree,
      ...(db !== undefined ? { db } : {}),
      ...(kind && collection !== undefined ? { collection, kind } : {}),
    };
  }
  const open = connectedMongo();
  return open.length === 1 ? { profile: open[0]! } : undefined;
}

/** The context, asking for the connection when several are open and none is in view. */
export async function resolveMongoContext(): Promise<MongoContext | undefined> {
  const context = mongoContext();
  if (context) return context;
  const profile = await quickPick({
    placeholder: 'Which MongoDB connection?',
    items: connectedMongo().map((candidate) => ({
      label: candidate.name,
      description: candidate.presentation.environment,
      icon: 'plug' as const,
      value: candidate,
    })),
  });
  return profile ? { profile } : undefined;
}

/** The context's database, asking for one when it has none. */
export async function pickDatabase(context: MongoContext): Promise<string | undefined> {
  if (context.db !== undefined) return context.db;
  await loadChildren(context.profile.id, []);
  const nodes = useExplorer.getState().children[context.profile.id]?.[pathKey([])]?.nodes ?? [];
  return quickPick({
    placeholder: `Which database of ${context.profile.name}?`,
    items: nodes
      .filter((node) => node.kind === 'database')
      .map((node) => ({ label: node.name, icon: 'database' as const, value: node.name })),
  });
}

/** The context's collection, asking for one (in its database, or after one) when it has none. */
export async function pickCollection(context: MongoContext): Promise<
  | {
      readonly db: string;
      readonly collection: string;
      readonly kind: NonNullable<MongoContext['kind']>;
    }
  | undefined
> {
  const db = await pickDatabase(context);
  if (db === undefined) return undefined;
  if (context.collection !== undefined && context.db === db) {
    return { db, collection: context.collection, kind: context.kind ?? 'collection' };
  }
  const folders = Object.entries(COLLECTION_FOLDERS);
  await Promise.all(
    folders.map(([folder]) =>
      loadChildren(context.profile.id, [db, folder]).catch(() => undefined),
    ),
  );
  const children = useExplorer.getState().children[context.profile.id] ?? {};
  const items = folders.flatMap(([folder, kind]) =>
    (children[pathKey([db, folder])]?.nodes ?? []).map((node) => ({
      label: node.name,
      description:
        kind === 'collection' ? db : `${db} · ${kind === 'view' ? 'view' : 'time series'}`,
      icon: 'table' as const,
      value: { db, collection: node.name, kind: kind! },
    })),
  );
  return quickPick({ placeholder: `Which collection of ${db}?`, items });
}
