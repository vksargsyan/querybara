import type { MongoCollectionChange } from '@querybara/ipc';
import {
  formatShellInline,
  fromEjson,
  toEjson,
  type BsonDocument,
  type Namespace,
} from '@querybara/mongo-tools';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

import { errorMessage } from '../../lib/errors';
import { mainApi } from '../../lib/main-client';
import { confirm } from '../dialogs';
import { patchPanel } from '../panels';
import { SessionLane } from '../session-lane';
import { namespaceReference } from './explorer';
import { DEFAULT_WRITE_RULES, loadWriteRules, type WriteRules } from './write-rules';

/**
 * Studio 3T's Collection History (ADR 0041): the documents changed through the collection tab
 * (inserted, edited whole or a value in place, deleted), recorded once each write succeeded,
 * with the document before and after. A change is undone only while the document is as the
 * change left it, and the undo is recorded too, so it can be undone in turn.
 */

export interface CollectionHistoryTarget {
  readonly profileId: string;
  readonly db: string;
  readonly collection: string;
}

/** A change to record: the document before (not for an insert) and after (not for a delete). */
export type RecordedChange =
  | { readonly operation: 'insert'; readonly after: string }
  | { readonly operation: 'update'; readonly before: string; readonly after: string }
  | { readonly operation: 'delete'; readonly before: string };

/** The canonical Extended JSON of a document's `_id`. */
function idOf(document: string): string {
  return toEjson((fromEjson(document) as BsonDocument)['_id'] ?? null);
}

/** Records a change in the collection history; recording never fails the write it follows. */
export function recordChange(target: CollectionHistoryTarget, change: RecordedChange): void {
  const before = change.operation === 'insert' ? null : change.before;
  const after = change.operation === 'delete' ? null : change.after;
  try {
    void mainApi()
      .mongo.changes.record({
        profileId: target.profileId,
        db: target.db,
        collection: target.collection,
        operation: change.operation,
        documentId: idOf((after ?? before)!),
        before,
        after,
      })
      .catch(() => undefined);
  } catch {
    // No main process to record into (a page without one), or a document it cannot read.
  }
}

/** A document as stored after an insert: the inserted id first when the server added it. */
export function insertedDocument(document: string, insertedId: string | undefined): string {
  const parsed = fromEjson(document) as BsonDocument;
  if (parsed['_id'] !== undefined || insertedId === undefined) return document;
  return toEjson({ _id: fromEjson(insertedId), ...parsed });
}

function same(a: string, b: string): boolean {
  return toEjson(fromEjson(a)) === toEjson(fromEjson(b));
}

export interface CollectionHistoryState {
  readonly changes: readonly MongoCollectionChange[];
  readonly loading: boolean;
  readonly selected: string | undefined;
  readonly writeRules: WriteRules;
  readonly notice: { readonly kind: 'success' | 'error'; readonly text: string } | undefined;
}

export class CollectionHistory {
  readonly id: string;
  readonly target: CollectionHistoryTarget;
  readonly store: StoreApi<CollectionHistoryState>;
  readonly #lane: SessionLane;

  constructor(id: string, target: CollectionHistoryTarget) {
    this.id = id;
    this.target = target;
    this.store = createStore<CollectionHistoryState>()(() => ({
      changes: [],
      loading: false,
      selected: undefined,
      writeRules: DEFAULT_WRITE_RULES,
      notice: undefined,
    }));
    this.#lane = new SessionLane(target.profileId, target.db);
  }

  get state(): CollectionHistoryState {
    return this.store.getState();
  }

  get ns(): Namespace {
    return { db: this.target.db, collection: this.target.collection };
  }

  #set(patch: Partial<CollectionHistoryState>): void {
    this.store.setState(patch);
  }

  async init(): Promise<void> {
    this.#set({ writeRules: await loadWriteRules(this.target.profileId) });
    await this.refresh();
  }

  async refresh(): Promise<void> {
    this.#set({ loading: true });
    try {
      const changes = await mainApi().mongo.changes.list({ ...this.target });
      const selected = changes.some((change) => change.id === this.state.selected)
        ? this.state.selected
        : changes[0]?.id;
      this.#set({ changes, selected });
    } catch (error) {
      this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
    } finally {
      this.#set({ loading: false });
    }
  }

  select(id: string): void {
    this.#set({ selected: id });
  }

  /** The command that undoes a change, as mongosh text. */
  undoCommand(change: MongoCollectionChange): string {
    const where = namespaceReference(this.target.db, this.target.collection);
    const id = formatShellInline(fromEjson(change.documentId));
    switch (change.operation) {
      case 'insert':
        return `${where}.deleteOne({ _id: ${id} })`;
      case 'update':
        return `${where}.replaceOne({ _id: ${id} }, ${formatShellInline(fromEjson(change.before!))})`;
      case 'delete':
        return `${where}.insertOne(${formatShellInline(fromEjson(change.before!))})`;
    }
  }

  /**
   * Undoes a change, after a confirmation that shows the command: an edit puts the document
   * back, an insert deletes it, a delete inserts it again. Refused when the document changed
   * since (or, for a delete, came back). True when undone.
   */
  async undo(change: MongoCollectionChange): Promise<boolean> {
    if (this.state.writeRules.readOnlyProfile) {
      this.#set({ notice: { kind: 'error', text: 'This connection is read-only.' } });
      return false;
    }
    const titles = {
      insert: 'Delete the inserted document?',
      update: 'Put the document back as it was?',
      delete: 'Insert the deleted document again?',
    } as const;
    const ok = await confirm({
      title: titles[change.operation],
      message: `${this.state.writeRules.production ? 'This connection is marked production. ' : ''}This runs:`,
      detail: this.undoCommand(change),
      confirmLabel: 'Undo',
      danger: change.operation === 'insert' || this.state.writeRules.production,
    });
    if (!ok) return false;
    patchPanel(this.id, { busy: true });
    try {
      const undone = await this.#apply(change);
      if (!undone) return false;
      await mainApi().mongo.changes.markReverted({ id: change.id });
      this.#set({ notice: { kind: 'success', text: 'Change undone' } });
      await this.refresh();
      return true;
    } catch (error) {
      this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
      return false;
    } finally {
      patchPanel(this.id, { busy: false });
    }
  }

  async #apply(change: MongoCollectionChange): Promise<boolean> {
    const { ns } = this;
    switch (change.operation) {
      case 'update': {
        // Only while the document is as the edit left it (CONFLICT otherwise).
        await this.#lane.run((host, sessionId) =>
          host.mongo.replaceOne({
            sessionId,
            ns,
            original: change.after!,
            replacement: change.before!,
            confirmed: true,
          }),
        );
        recordChange(this.target, {
          operation: 'update',
          before: change.after!,
          after: change.before!,
        });
        return true;
      }
      case 'insert': {
        const current = await this.#current(change.documentId);
        if (current === undefined) {
          this.#set({ notice: { kind: 'error', text: 'The document is already gone.' } });
          return false;
        }
        if (!same(current, change.after!)) {
          this.#set({
            notice: {
              kind: 'error',
              text: 'The document changed since it was inserted, so it was not deleted.',
            },
          });
          return false;
        }
        await this.#lane.run((host, sessionId) =>
          host.mongo.deleteOne({ sessionId, ns, id: change.documentId, confirmed: true }),
        );
        recordChange(this.target, { operation: 'delete', before: current });
        return true;
      }
      case 'delete': {
        await this.#lane.run((host, sessionId) =>
          host.mongo.insertOne({ sessionId, ns, document: change.before!, confirmed: true }),
        );
        recordChange(this.target, { operation: 'insert', after: change.before! });
        return true;
      }
    }
  }

  /** The stored document with this `_id`, or undefined. */
  async #current(documentId: string): Promise<string | undefined> {
    return this.#lane.run(async (host, sessionId) => {
      const stream = host.mongo.find({
        sessionId,
        ns: this.ns,
        query: { filter: toEjson({ _id: fromEjson(documentId) }), limit: 1 },
        pageSize: 1,
      });
      for await (const page of stream) {
        if (page.documents[0] !== undefined) return page.documents[0];
      }
      return undefined;
    });
  }

  /** Forgets the collection's history, after a confirmation. */
  async clear(): Promise<void> {
    const ok = await confirm({
      title: `Clear the history of ${this.target.collection}?`,
      message:
        'The recorded changes are forgotten; the documents stay as they are. Changes made from now on are recorded again.',
      confirmLabel: 'Clear',
    });
    if (!ok) return;
    await mainApi().mongo.changes.clear({ ...this.target });
    await this.refresh();
  }

  dismissNotice(): void {
    this.#set({ notice: undefined });
  }

  async dispose(): Promise<void> {
    await this.#lane.close();
  }
}

export function useCollectionHistory<T>(
  panel: CollectionHistory,
  select: (state: CollectionHistoryState) => T,
): T {
  return useStore(panel.store, select);
}
