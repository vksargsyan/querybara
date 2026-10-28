import { QuerybaraError, requiresWriteConfirmation } from '@querybara/core';
import type { TransferJob } from '@querybara/ipc';
import {
  formatShell,
  fromEjson,
  isBsonDocument,
  parseShell,
  toEjson,
  type BsonDocument,
} from '@querybara/mongo-tools';
import { create } from 'zustand';

import { copyToClipboard } from '../../lib/clipboard';
import { errorMessage } from '../../lib/errors';
import { profileById } from '../data';
import { confirm } from '../dialogs';
import { loadChildren } from '../explorer';
import { SessionLane } from '../session-lane';
import { transferDbApi } from '../transfer-db/api';
import { openDuplicateCollection } from './collection-actions';
import { namespaceReference } from './explorer';
import { refreshAfter } from './file-transfer';

/**
 * Studio 3T's Copy and Paste for MongoDB (ADR 0036): documents copied from a result paste into
 * any collection, of any connection; a collection copied in the tree pastes into any database,
 * with its documents and indexes (a transfer job between connections, a duplicate within one
 * database). Copies also go to the system clipboard as mongosh text; the page cannot read the
 * system clipboard, so Paste Documents… shows the copied documents in an editor where text
 * from elsewhere can be pasted too.
 */

export type MongoClipboard =
  | {
      readonly kind: 'documents';
      readonly profileId: string;
      readonly db: string;
      readonly collection: string;
      /** Canonical Extended JSON of each document. */
      readonly documents: readonly string[];
    }
  | {
      readonly kind: 'collection';
      readonly profileId: string;
      readonly profileName: string;
      readonly db: string;
      readonly collection: string;
    };

export interface PasteTarget {
  readonly profileId: string;
  readonly profileName: string;
  readonly db: string;
  readonly collection: string;
  readonly production: boolean;
  readonly confirmWrites: boolean;
  readonly readOnly: boolean;
}

interface ClipboardState {
  readonly clipboard: MongoClipboard | undefined;
  /** The Paste Documents dialog, when open. */
  readonly paste: PasteTarget | undefined;
}

export const useMongoClipboard = create<ClipboardState>()(() => ({
  clipboard: undefined,
  paste: undefined,
}));

/** Copies documents (canonical Extended JSON) for Paste Documents, and as mongosh text. */
export function copyDocuments(
  source: { readonly profileId: string; readonly db: string; readonly collection: string },
  documents: readonly string[],
): void {
  if (documents.length === 0) return;
  useMongoClipboard.setState({ clipboard: { kind: 'documents', ...source, documents } });
  copyToClipboard(documentsText(documents));
}

/** Copies a collection for Paste Collection, and its name as text. */
export async function copyCollection(
  profileId: string,
  db: string,
  collection: string,
): Promise<void> {
  const profile = await profileById(profileId);
  if (!profile) return;
  useMongoClipboard.setState({
    clipboard: { kind: 'collection', profileId, profileName: profile.name, db, collection },
  });
  copyToClipboard(collection);
}

/** Documents as the paste editor shows them: one document, or an array of them. */
export function documentsText(documents: readonly string[]): string {
  const values = documents.map((text) => fromEjson(text, 'document'));
  return formatShell(values.length === 1 ? values[0]! : values);
}

/**
 * The documents in the paste editor's text: one document or an array of them, in mongosh
 * syntax (Extended JSON is mongosh too). With `newIds`, each loses its `_id` for a new one.
 */
export function pastedDocuments(text: string, newIds: boolean): BsonDocument[] {
  const value = parseShell(text);
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0) {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: 'There are no documents to paste',
    });
  }
  return values.map((item, i) => {
    if (!isBsonDocument(item) || Array.isArray(item)) {
      throw new QuerybaraError({
        code: 'VALIDATION_FAILED',
        message: `Item ${i + 1} is not a document`,
      });
    }
    if (!newIds) return item;
    const copy: BsonDocument = {};
    for (const key of Object.keys(item)) if (key !== '_id') copy[key] = item[key]!;
    return copy;
  });
}

export async function openPasteDocuments(
  profileId: string,
  db: string,
  collection: string,
): Promise<void> {
  const profile = await profileById(profileId);
  if (!profile) return;
  useMongoClipboard.setState({
    paste: {
      profileId,
      profileName: profile.name,
      db,
      collection,
      production: profile.presentation.environment === 'production',
      confirmWrites: requiresWriteConfirmation(profile),
      readOnly: profile.presentation.readOnly,
    },
  });
}

export function closePasteDocuments(): void {
  useMongoClipboard.setState({ paste: undefined });
}

const lanes = new Map<string, SessionLane>();

function laneFor(profileId: string): SessionLane {
  let lane = lanes.get(profileId);
  if (!lane) {
    lane = new SessionLane(profileId);
    lanes.set(profileId, lane);
  }
  return lane;
}

/**
 * Inserts the pasted documents, in order, after the confirmation a write needs there. Resolves
 * the number inserted; a refused document (a taken `_id`) stops the paste with its position.
 */
export async function pasteDocuments(
  target: PasteTarget,
  documents: readonly BsonDocument[],
): Promise<number | undefined> {
  if (target.readOnly) {
    throw new QuerybaraError({ code: 'READ_ONLY', message: 'This connection is read-only' });
  }
  const ns = { db: target.db, collection: target.collection };
  if (target.confirmWrites) {
    const ok = await confirm({
      title: `Paste ${documents.length === 1 ? 'a document' : `${documents.length} documents`}?`,
      message: target.production
        ? 'This connection is marked production, so every write asks first. This runs:'
        : 'This connection asks before every write. This runs:',
      detail: `${namespaceReference(target.db, target.collection)}.insertMany([ … ${documents.length} … ])`,
      confirmLabel: 'Paste',
      danger: target.production,
    });
    if (!ok) return undefined;
  }
  const result = await laneFor(target.profileId).run((host, sessionId) =>
    host.mongo.insertMany({
      sessionId,
      ns,
      documents: toEjson(documents),
      ordered: true,
      confirmed: target.confirmWrites,
    }),
  );
  return result.insertedCount;
}

/**
 * Pastes the copied collection into a database: within its own database, as a duplicate under
 * a new name; elsewhere (another database, another connection), as a transfer job that copies
 * its documents and indexes into a new collection of the same name.
 */
export async function pasteCollection(profileId: string, db: string): Promise<void> {
  const clip = useMongoClipboard.getState().clipboard;
  if (clip?.kind !== 'collection') return;
  if (clip.profileId === profileId && clip.db === db) {
    openDuplicateCollection(profileId, db, clip.collection);
    return;
  }
  const target = await profileById(profileId);
  if (!target) return;
  if (target.presentation.readOnly) {
    await confirm({
      title: 'This connection is read-only',
      message: `Nothing can be pasted into "${target.name}".`,
      confirmLabel: 'OK',
    });
    return;
  }
  const where = `${target.name} › ${db}`;
  const ok = await confirm({
    title: `Paste ${clip.collection} into ${db}?`,
    message: `Its documents and indexes are copied from ${clip.profileName} › ${clip.db} into a new collection ${clip.collection} of ${where}${
      target.presentation.environment === 'production' ? ', a production connection' : ''
    }. A collection of that name there stops the copy.`,
    confirmLabel: 'Paste',
    danger: target.presentation.environment === 'production',
  });
  if (!ok) return;
  const job: TransferJob = {
    kind: 'transfer',
    profileId: clip.profileId,
    database: clip.db,
    objects: [{ name: clip.collection }],
    target: { profileId, database: db },
    options: { mode: 'create' },
    confirmed: true,
  };
  try {
    // Both connections' "ask every time" secrets, as the Transfer wizard asks for them.
    const jobId = await transferDbApi().start(job);
    if (jobId !== undefined) refreshAfter(jobId, profileId, db);
  } catch (error) {
    if (error instanceof QuerybaraError && error.code === 'CANCELLED') return;
    await confirm({
      title: 'The collection was not pasted',
      message: errorMessage(error),
      confirmLabel: 'OK',
    });
  }
}

/** After a paste of documents: the side bar lists a collection the paste created. */
export function refreshCollections(profileId: string, db: string): void {
  void loadChildren(profileId, [db, 'collections']).catch(() => undefined);
}
