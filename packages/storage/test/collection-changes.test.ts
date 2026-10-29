import { describe, expect, it } from 'vitest';

import { CHANGES_KEPT, MIGRATIONS } from '../src';
import { memoryStore, postgresProfile, thrown } from './helpers';

/** The collection history (ADR 0041): changes per collection, newest first, kept to a limit. */

describe('collection changes', () => {
  function setup() {
    const store = memoryStore();
    const profile = store.profiles.save(
      postgresProfile({
        name: 'Mongo',
        engine: 'mongodb',
        endpoint: { kind: 'host', host: 'localhost', port: 27017 },
        auth: { method: 'none' },
      }),
    );
    const scope = { profileId: profile.id, database: 'shop', collection: 'orders' };
    return { store, profile, scope };
  }

  it('is migration 7', () => {
    expect(MIGRATIONS.find((m) => m.name === 'collection history')?.version).toBe(7);
  });

  it('records inserts, updates and deletes, newest first, and marks undone ones', () => {
    const { store, scope } = setup();
    const id = '{"$numberInt":"1"}';
    const inserted = store.collectionChanges.record({
      ...scope,
      operation: 'insert',
      documentId: id,
      before: null,
      after: '{"_id":{"$numberInt":"1"},"a":"x"}',
    })!;
    const updated = store.collectionChanges.record({
      ...scope,
      operation: 'update',
      documentId: id,
      before: '{"_id":{"$numberInt":"1"},"a":"x"}',
      after: '{"_id":{"$numberInt":"1"},"a":"y"}',
    })!;
    store.collectionChanges.record({
      ...scope,
      collection: 'other',
      operation: 'delete',
      documentId: id,
      before: '{"_id":{"$numberInt":"1"}}',
      after: null,
    });
    expect(store.collectionChanges.list(scope).map((c) => c.id)).toEqual([updated.id, inserted.id]);
    expect(updated).toMatchObject({ operation: 'update', revertedAt: null });
    expect(store.collectionChanges.markReverted(updated.id)).toBe(true);
    expect(store.collectionChanges.get(updated.id)?.revertedAt).not.toBeNull();
    expect(store.collectionChanges.markReverted('missing')).toBe(false);
    expect(store.collectionChanges.clear(scope)).toBe(2);
    expect(store.collectionChanges.list(scope)).toEqual([]);
    expect(store.collectionChanges.list({ ...scope, collection: 'other' })).toHaveLength(1);
  });

  it('refuses a change without the versions it needs, and skips a deleted profile', () => {
    const { store, profile, scope } = setup();
    expect(
      thrown(() =>
        store.collectionChanges.record({
          ...scope,
          operation: 'update',
          documentId: '1',
          before: null,
          after: '{}x',
        }),
      ),
    ).toMatchObject({ code: 'VALIDATION_FAILED' });
    store.profiles.delete(profile.id);
    expect(
      store.collectionChanges.record({
        ...scope,
        operation: 'delete',
        documentId: '1',
        before: '{"_id":1}',
        after: null,
      }),
    ).toBeUndefined();
  });

  it('keeps the newest changes of a collection, and goes with its connection', () => {
    const { store, profile, scope } = setup();
    for (let i = 0; i < CHANGES_KEPT + 3; i++) {
      store.collectionChanges.record({
        ...scope,
        operation: 'insert',
        documentId: String(i),
        before: null,
        after: `{"_id":${i}}`,
      });
    }
    const kept = store.collectionChanges.list(scope);
    expect(kept).toHaveLength(CHANGES_KEPT);
    expect(kept[0]?.documentId).toBe(String(CHANGES_KEPT + 2));
    expect(kept.at(-1)?.documentId).toBe('3');
    store.profiles.delete(profile.id);
    expect(store.collectionChanges.list(scope)).toEqual([]);
  });
});
