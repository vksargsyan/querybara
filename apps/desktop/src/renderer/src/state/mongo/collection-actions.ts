import { copiedIndexes, toEjson } from '@querybara/mongo-tools';
import { create } from 'zustand';

import { errorMessage } from '../../lib/errors';
import { confirm } from '../dialogs';
import { loadChildren } from '../explorer';
import { SessionLane } from '../session-lane';
import { namespaceReference } from './explorer';

/**
 * Studio 3T's collection actions in the tree's menu (ADR 0036): Rename Collection…, Duplicate
 * Collection… (documents and indexes, into a new collection) and Clear Collection… (every
 * document deleted, the collection and its indexes kept). Each shows its exact command first;
 * the connection host applies the write rules again, so a read-only profile refuses them.
 */

export interface NameAction {
  readonly kind: 'rename' | 'duplicate';
  readonly profileId: string;
  readonly db: string;
  readonly collection: string;
  /** Confirming or running: the name dialog steps aside for the confirmation. */
  readonly busy: boolean;
  readonly error: string | undefined;
  /** The name last submitted, which the dialog shows again after an error. */
  readonly name?: string;
}

export const useCollectionActions = create<{ readonly action: NameAction | undefined }>()(() => ({
  action: undefined,
}));

const lanes = new Map<string, SessionLane>();

function laneFor(profileId: string): SessionLane {
  let lane = lanes.get(profileId);
  if (!lane) {
    lane = new SessionLane(profileId);
    lanes.set(profileId, lane);
  }
  return lane;
}

function patch(next: Partial<NameAction>): void {
  const action = useCollectionActions.getState().action;
  if (action) useCollectionActions.setState({ action: { ...action, ...next } });
}

export function openRenameCollection(profileId: string, db: string, collection: string): void {
  useCollectionActions.setState({
    action: { kind: 'rename', profileId, db, collection, busy: false, error: undefined },
  });
}

export function openDuplicateCollection(profileId: string, db: string, collection: string): void {
  useCollectionActions.setState({
    action: { kind: 'duplicate', profileId, db, collection, busy: false, error: undefined },
  });
}

export function closeCollectionAction(): void {
  useCollectionActions.setState({ action: undefined });
}

/** The name a duplicate starts with: "orders_copy", or "orders_copy_2" and on when taken. */
export function copyName(collection: string, taken: readonly string[] = []): string {
  const base = `${collection}_copy`;
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base}_${n}`)) return `${base}_${n}`;
}

/** What the server says about a collection name, before asking it. */
export function collectionNameIssue(name: string): string | undefined {
  if (name.trim() === '') return 'Name the collection';
  if (name.includes('$')) return 'A collection name cannot contain $';
  if (name.includes('\0')) return 'A collection name cannot contain the null character';
  if (name.startsWith('system.')) return 'Names starting with system. are reserved';
  return undefined;
}

/** Renames or duplicates the collection of the open dialog to `name`, after confirming. */
export async function submitCollectionName(name: string): Promise<void> {
  const action = useCollectionActions.getState().action;
  if (!action || action.busy) return;
  const issue = collectionNameIssue(name);
  if (issue !== undefined || name === action.collection) {
    patch({ error: issue ?? 'Choose another name', name });
    return;
  }
  patch({ busy: true, error: undefined, name });
  const from = namespaceReference(action.db, action.collection);
  const to = namespaceReference(action.db, name);
  const ok = await confirm(
    action.kind === 'rename'
      ? {
          title: `Rename ${action.db}.${action.collection}?`,
          message: 'Open tabs on the collection keep its old name. This runs:',
          detail: `${from}.renameCollection(${JSON.stringify(name)})`,
          confirmLabel: 'Rename',
        }
      : {
          title: `Duplicate ${action.db}.${action.collection}?`,
          message: 'Its documents are copied into a new collection, then its indexes. This runs:',
          detail: `${from}.aggregate([{ $match: {} }, { $out: ${JSON.stringify(name)} }])\n// then ${to}.createIndex(…) for each index`,
          confirmLabel: 'Duplicate',
        },
  );
  if (!ok) {
    patch({ busy: false });
    return;
  }
  const ns = { db: action.db, collection: action.collection };
  try {
    await laneFor(action.profileId).run(async (host, sessionId) => {
      if (action.kind === 'rename') {
        await host.mongo.collections.rename({ sessionId, ns, to: name, confirmed: true });
        return;
      }
      const copy = host.mongo.aggregate({
        sessionId,
        ns,
        pipeline: toEjson([{ $match: {} }, { $out: name }]),
        confirmed: true,
      });
      for await (const _page of copy) {
        // $out returns no documents; reading the stream runs the pipeline to the end.
      }
      const indexes = await host.mongo.indexes.list({ sessionId, ns });
      for (const spec of copiedIndexes(indexes)) {
        await host.mongo.indexes.create({
          sessionId,
          ns: { db: action.db, collection: name },
          spec,
          confirmed: true,
        });
      }
    });
    closeCollectionAction();
    await loadChildren(action.profileId, [action.db, 'collections']);
  } catch (error) {
    patch({ busy: false, error: errorMessage(error) });
  }
}

/** Deletes every document of a collection after confirming (Studio 3T's Clear Collection). */
export async function clearCollection(
  profileId: string,
  db: string,
  collection: string,
): Promise<void> {
  const ok = await confirm({
    title: `Clear ${db}.${collection}?`,
    message: 'Every document is deleted; the collection and its indexes stay. This runs:',
    detail: `${namespaceReference(db, collection)}.deleteMany({})`,
    confirmLabel: 'Clear',
    danger: true,
  });
  if (!ok) return;
  await laneFor(profileId).run((host, sessionId) =>
    host.mongo.deleteMany({ sessionId, ns: { db, collection }, filter: '{}', confirmed: true }),
  );
  await loadChildren(profileId, [db, 'collections']);
}
