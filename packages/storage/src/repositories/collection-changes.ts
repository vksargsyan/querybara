import { newId } from '@querybara/core';
import { z } from 'zod';

import type { RepositoryContext } from '../internal/context';
import { parseOrThrow } from '../internal/errors';
import { readNullableText, readText } from '../internal/rows';
import type { SqlRow, SqliteDatabase } from '../sqlite';

/** What a change did to a document. */
export const CHANGE_OPERATIONS = ['insert', 'update', 'delete'] as const;
export type ChangeOperation = (typeof CHANGE_OPERATIONS)[number];

/** The changes kept per collection; older ones are dropped as new ones come. */
export const CHANGES_KEPT = 500;

/** The largest document version kept, in UTF-16 code units (MongoDB's 16 MB, as Extended JSON). */
export const MAX_CHANGE_DOCUMENT = 32_000_000;

const documentSchema = z.string().min(2).max(MAX_CHANGE_DOCUMENT);

/**
 * A document changed through the app's MongoDB views (ADR 0041): inserted, edited (a whole
 * document or a value in place) or deleted, with its canonical Extended JSON before and after,
 * so the change can be undone. Bulk updates and deletes, and scripts, are not recorded.
 */
export const collectionChangeSchema = z.object({
  id: z.string().min(1),
  profileId: z.string().min(1),
  database: z.string().min(1).max(256),
  collection: z.string().min(1).max(1024),
  operation: z.enum(CHANGE_OPERATIONS),
  /** Canonical Extended JSON of the document's `_id`. */
  documentId: z.string().min(1).max(4096),
  /** The document before; null for an insert. */
  before: documentSchema.nullable(),
  /** The document after; null for a delete. */
  after: documentSchema.nullable(),
  changedAt: z.iso.datetime({ offset: true }),
  /** When the change was undone from the history, if it was. */
  revertedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type CollectionChange = z.infer<typeof collectionChangeSchema>;

const recordSchema = collectionChangeSchema
  .omit({ id: true, changedAt: true, revertedAt: true })
  .refine((change) => change.operation === 'insert' || change.before !== null, {
    message: 'An update or delete records the document before',
  })
  .refine((change) => change.operation === 'delete' || change.after !== null, {
    message: 'An insert or update records the document after',
  });
export type CollectionChangeInput = z.input<typeof recordSchema>;

export interface CollectionScope {
  readonly profileId: string;
  readonly database: string;
  readonly collection: string;
}

/**
 * The collection history: changes recorded newest first per collection, at most CHANGES_KEPT
 * each. A change of a profile deleted meanwhile is not recorded (and the rest go with it).
 */
export class CollectionChangeRepository {
  readonly #db: SqliteDatabase;
  readonly #now: () => string;

  constructor(context: RepositoryContext) {
    this.#db = context.db;
    this.#now = context.now;
  }

  /** Records a change; undefined when its profile is gone. */
  record(input: CollectionChangeInput): CollectionChange | undefined {
    const change = parseOrThrow(recordSchema, input, 'collection change');
    return this.#db.transaction(() => {
      if (!this.#db.get('SELECT 1 AS found FROM profiles WHERE id = ?', [change.profileId])) {
        return undefined;
      }
      const id = newId();
      this.#db.run(
        `INSERT INTO collection_changes (id, profile_id, database_name, collection_name,
           operation, document_id, before, after, changed_at, reverted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        [
          id,
          change.profileId,
          change.database,
          change.collection,
          change.operation,
          change.documentId,
          change.before,
          change.after,
          this.#now(),
        ],
      );
      this.#db.run(
        `DELETE FROM collection_changes
         WHERE profile_id = ? AND database_name = ? AND collection_name = ? AND id NOT IN (
           SELECT id FROM collection_changes
           WHERE profile_id = ? AND database_name = ? AND collection_name = ?
           ORDER BY changed_at DESC, rowid DESC LIMIT ?)`,
        [
          change.profileId,
          change.database,
          change.collection,
          change.profileId,
          change.database,
          change.collection,
          CHANGES_KEPT,
        ],
      );
      return this.get(id);
    });
  }

  /** A collection's changes, newest first. */
  list(scope: CollectionScope, options: { readonly limit?: number } = {}): CollectionChange[] {
    return this.#db
      .all(
        `SELECT * FROM collection_changes
         WHERE profile_id = ? AND database_name = ? AND collection_name = ?
         ORDER BY changed_at DESC, rowid DESC LIMIT ?`,
        [scope.profileId, scope.database, scope.collection, options.limit ?? CHANGES_KEPT],
      )
      .map(toChange);
  }

  get(id: string): CollectionChange | undefined {
    const row = this.#db.get('SELECT * FROM collection_changes WHERE id = ?', [id]);
    return row ? toChange(row) : undefined;
  }

  /** Marks a change as undone; false when it is not recorded (any more). */
  markReverted(id: string): boolean {
    return (
      this.#db.run('UPDATE collection_changes SET reverted_at = ? WHERE id = ?', [this.#now(), id])
        .changes > 0
    );
  }

  /** Forgets a collection's changes; returns how many there were. */
  clear(scope: CollectionScope): number {
    return this.#db.run(
      `DELETE FROM collection_changes
       WHERE profile_id = ? AND database_name = ? AND collection_name = ?`,
      [scope.profileId, scope.database, scope.collection],
    ).changes;
  }
}

function toChange(row: SqlRow): CollectionChange {
  return {
    id: readText(row, 'id'),
    profileId: readText(row, 'profile_id'),
    database: readText(row, 'database_name'),
    collection: readText(row, 'collection_name'),
    operation: readText(row, 'operation') as ChangeOperation,
    documentId: readText(row, 'document_id'),
    before: readNullableText(row, 'before'),
    after: readNullableText(row, 'after'),
    changedAt: readText(row, 'changed_at'),
    revertedAt: readNullableText(row, 'reverted_at'),
  };
}
