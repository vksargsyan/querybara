import { toEjson, type IndexInfo } from '@querybara/mongo-tools';
import { describe, expect, it } from 'vitest';

import {
  collectionNameIssue,
  copyName,
  indexSpecOf,
} from '../src/renderer/src/state/mongo/collection-actions';
import { defaultShellScript } from '../src/renderer/src/state/mongo/explorer';
import { elapsed } from '../src/renderer/src/state/mongo/pages';

/** The Studio 3T-shaped pieces of the MongoDB module (ADR 0036). */

function index(partial: Partial<IndexInfo>): IndexInfo {
  return {
    name: 'total_1',
    keys: toEjson({ total: 1 }),
    kind: 'single',
    unique: false,
    sparse: false,
    hidden: false,
    spec: '{}',
    ...partial,
  };
}

describe('collection actions', () => {
  it('names a duplicate after the collection, past the names taken', () => {
    expect(copyName('orders')).toBe('orders_copy');
    expect(copyName('orders', ['orders_copy', 'orders_copy_2'])).toBe('orders_copy_3');
  });

  it('checks a collection name before the server does', () => {
    expect(collectionNameIssue('orders')).toBeUndefined();
    expect(collectionNameIssue('  ')).toBe('Name the collection');
    expect(collectionNameIssue('a$b')).toMatch(/\$/);
    expect(collectionNameIssue('system.users')).toMatch(/reserved/);
  });

  it('recreates an index with its options on another collection', () => {
    expect(
      indexSpecOf(
        index({
          unique: true,
          hidden: true,
          expireAfterSeconds: 60,
          partialFilterExpression: toEjson({ total: { $gt: 1 } }),
        }),
      ),
    ).toEqual({
      keys: toEjson({ total: 1 }),
      name: 'total_1',
      unique: true,
      hidden: true,
      expireAfterSeconds: 60,
      partialFilterExpression: toEjson({ total: { $gt: 1 } }),
    });
  });

  it('recreates a text index from its weights, not its internal keys', () => {
    const spec = indexSpecOf(
      index({
        name: 'body_text',
        kind: 'text',
        keys: toEjson({ _fts: 'text', _ftsx: 1 }),
        spec: toEjson({ weights: { body: 1, title: 10 }, default_language: 'english' }),
      }),
    );
    expect(spec).toMatchObject({
      keys: toEjson({ body: 'text', title: 'text' }),
      weights: toEjson({ body: 1, title: 10 }),
      defaultLanguage: 'english',
    });
  });
});

describe('collection tab', () => {
  it('shows the first page time as Studio 3T’s stopwatch does', () => {
    expect(elapsed(5)).toBe('00:00:00.005');
    expect(elapsed(3_723_456)).toBe('01:02:03.456');
  });

  it('starts IntelliShell on a collection with its find()', () => {
    expect(defaultShellScript('orders')).toBe('db.orders.find({})');
    expect(defaultShellScript('line items')).toBe("db.getCollection('line items').find({})");
  });
});
