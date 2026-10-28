import { randomBytes } from 'node:crypto';

import type { MongoSession } from '@querybara/driver-mongodb';
import {
  Decimal128,
  Int32,
  Long,
  ObjectId,
  UUID,
  toEjson,
  type BsonDocument,
} from '@querybara/mongo-tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { planDbTransfer, runDbTransfer } from '../../src';
import { MONGO_URL, connectMongo, opener } from './db-helpers';

/**
 * MongoDB → MongoDB transfers against a real server (ADR 0036, Paste Collection): documents
 * cross with every BSON type, indexes follow, and the target modes behave as for SQL → MongoDB.
 * Two databases stand in for two connections.
 */

const ORDERS: BsonDocument[] = Array.from({ length: 1200 }, (_, i) => ({
  _id: new Int32(i + 1),
  status: i % 2 === 0 ? 'open' : 'shipped',
  total: Decimal128.fromString(`${i}.5`),
  big: Long.fromString('9007199254740993'),
  at: new Date(Date.UTC(2026, 0, 1 + (i % 28))),
  ref: new ObjectId(),
  uuid: new UUID().toBinary(),
  customer: { name: `Customer ${i % 7}`, tags: ['a', 'b'] },
}));

async function all(session: MongoSession, db: string, collection: string): Promise<string[]> {
  const out: string[] = [];
  for await (const page of session.find({ db, collection }, { sort: '{"_id": 1}' })) {
    out.push(...page.documents);
  }
  return out;
}

describe.skipIf(!MONGO_URL)('MongoDB → MongoDB', () => {
  const from = `mm_src_${randomBytes(4).toString('hex')}`;
  const to = `mm_dst_${randomBytes(4).toString('hex')}`;
  let mongo: MongoSession;

  beforeAll(async () => {
    mongo = (await connectMongo(from)) as MongoSession;
    await mongo.insertMany({ db: from, collection: 'orders' }, toEjson(ORDERS));
    await mongo.createIndex(
      { db: from, collection: 'orders' },
      { keys: '{"status": 1, "at": -1}', name: 'status_at' },
    );
    await mongo.createIndex(
      { db: from, collection: 'orders' },
      { keys: '{"ref": 1}', name: 'ref_unique', unique: true },
    );
    await mongo.createCollection({ db: from, collection: 'checked' });
  });

  afterAll(async () => {
    await mongo?.dropDatabase(from).catch(() => undefined);
    await mongo?.dropDatabase(to).catch(() => undefined);
    await mongo?.close();
  });

  const spec = (mode: 'create' | 'drop-create' | 'truncate' | 'append' = 'create') => ({
    source: { database: from },
    target: { database: to },
    objects: [{ name: 'orders', target: 'orders_copy' }],
    options: { mode, batchSize: 500 },
  });

  it('plans the copy: the collection, its indexes, and no columns to map', async () => {
    const plan = await planDbTransfer({ spec: spec(), source: mongo, target: mongo });
    expect(plan.problems).toEqual([]);
    expect(plan.tables).toEqual([
      expect.objectContaining({
        source: 'orders',
        target: 'orders_copy',
        kind: 'collection',
        action: 'create',
        exists: false,
        rows: ORDERS.length,
        columns: [],
      }),
    ]);
    expect(plan.before).toEqual(['db.createCollection("orders_copy")']);
    expect(plan.after).toEqual([
      'db.orders_copy.createIndex({ status: 1, at: -1 }, {"name":"status_at"})',
      'db.orders_copy.createIndex({ ref: 1 }, {"name":"ref_unique","unique":true})',
    ]);
  });

  it('copies every document with its types, then the indexes', async () => {
    const summary = await runDbTransfer({
      spec: spec(),
      source: opener(() => connectMongo(from)),
      target: opener(() => connectMongo(to)),
    });
    expect(summary).toMatchObject({ status: 'completed', rowsWritten: ORDERS.length });
    expect(await all(mongo, to, 'orders_copy')).toEqual(await all(mongo, from, 'orders'));
    const indexes = await mongo.listIndexes({ db: to, collection: 'orders_copy' });
    expect(indexes.map((index) => [index.name, index.unique])).toEqual([
      ['_id_', false],
      ['status_at', false],
      ['ref_unique', true],
    ]);
  });

  it('refuses to create over an existing collection, and appends or truncates when asked', async () => {
    const again = await planDbTransfer({ spec: spec(), source: mongo, target: mongo });
    expect(again.problems).toEqual([
      'orders: orders_copy already exists on the target; choose drop and create, truncate or append',
    ]);
    const truncated = await runDbTransfer({
      spec: spec('truncate'),
      source: opener(() => connectMongo(from)),
      target: opener(() => connectMongo(to)),
    });
    expect(truncated).toMatchObject({ status: 'completed', rowsWritten: ORDERS.length });
    expect(await mongo.count({ db: to, collection: 'orders_copy' })).toBe(ORDERS.length);
    // Appending the same _ids is refused at the first document, which the summary names.
    const appended = await runDbTransfer({
      spec: spec('append'),
      source: opener(() => connectMongo(from)),
      target: opener(() => connectMongo(to)),
    });
    expect(appended.status).toBe('failed');
    expect(appended.errors[0]?.message).toMatch(/duplicate key/);
  });

  it('refuses a view and a collection that is not there', async () => {
    await mongo.createView({ db: from, collection: 'open_orders' }, 'orders', '[]');
    const plan = await planDbTransfer({
      spec: {
        source: { database: from },
        target: { database: to },
        objects: [{ name: 'open_orders' }, { name: 'missing' }],
      },
      source: mongo,
      target: mongo,
    });
    expect(plan.problems).toEqual([
      'open_orders: open_orders is a view: copy the collection it reads instead',
      'missing: Collection missing was not found on the source',
    ]);
  });
});
