import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MongoSession } from '@querybara/driver-mongodb';
import {
  Binary,
  Decimal128,
  EJSON,
  Int32,
  Long,
  ObjectId,
  UUID,
  toEjson,
  type BsonDocument,
} from '@querybara/mongo-tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { exportCollection, fileSink, fileSource, importCollection, openInput } from '../../src';
import { MONGO_URL, connectMongo } from './db-helpers';

/**
 * MongoDB collections to and from files against a real server (ADR 0037): each format written
 * from a collection reads back into another with the same documents, the upsert mode replaces
 * by `_id`, and a refused document is reported with its row.
 */

const ORDERS: BsonDocument[] = Array.from({ length: 2500 }, (_, i) => ({
  _id: new Int32(i + 1),
  status: i % 2 === 0 ? 'open' : 'shipped',
  total: Decimal128.fromString(`${i}.25`),
  big: Long.fromString(`${9007199254740993n + BigInt(i)}`),
  at: new Date(Date.UTC(2026, 0, 1 + (i % 28))),
  ref: new ObjectId(),
  uuid: new UUID().toBinary(),
  raw: new Binary(Buffer.from([i % 256, 1, 2])),
  customer: { name: `Customer ${i % 7}`, address: { city: 'Paris' } },
  items: [{ sku: `sku-${i}`, qty: new Int32(2) }],
}));

async function all(session: MongoSession, db: string, collection: string): Promise<string[]> {
  const out: string[] = [];
  for await (const page of session.find({ db, collection }, { sort: '{"_id": 1}' })) {
    out.push(...page.documents);
  }
  return out;
}

describe.skipIf(!MONGO_URL)('MongoDB files', () => {
  const db = `mfiles_${randomBytes(4).toString('hex')}`;
  let mongo: MongoSession;
  let work: string;

  beforeAll(async () => {
    mongo = (await connectMongo(db)) as MongoSession;
    await mongo.insertMany({ db, collection: 'orders' }, toEjson(ORDERS));
    work = await mkdtemp(join(tmpdir(), 'qb-mongo-files-'));
  });

  afterAll(async () => {
    await mongo?.dropDatabase(db).catch(() => undefined);
    await mongo?.close();
    await rm(work, { recursive: true, force: true });
  });

  for (const [format, options] of [
    ['json', { ejson: 'canonical' }],
    ['jsonl', {}],
    ['bson', {}],
  ] as const) {
    it(`round-trips every document through ${format}${options.ejson ? ` (${options.ejson})` : ''}`, async () => {
      const path = join(work, `orders.${format}.gz`);
      const exported = await exportCollection(
        mongo,
        { db, collection: 'orders' },
        {},
        fileSink(path, { gzip: true }),
        { format, ...options },
      );
      expect(exported.documents).toBe(ORDERS.length);
      const target = `orders_${format}`;
      const input = await openInput(fileSource(path));
      const imported = await importCollection(mongo, { db, collection: target }, input.source, {
        format,
      });
      expect(imported).toMatchObject({ read: ORDERS.length, written: ORDERS.length, skipped: 0 });
      expect(await all(mongo, db, target)).toEqual(await all(mongo, db, 'orders'));
    });
  }

  it('exports a query to CSV and reads it back with its types', async () => {
    const path = join(work, 'open.csv');
    await exportCollection(
      mongo,
      { db, collection: 'orders' },
      { filter: toEjson({ status: 'open', _id: { $lte: 3 } }), sort: '{"_id": 1}' },
      fileSink(path),
      { format: 'csv', fields: ['_id', 'status', 'customer.address.city', 'at', 'items'] },
    );
    expect((await readFile(path, 'utf8')).split('\r\n')).toEqual([
      '_id,status,customer.address.city,at,items',
      '1,open,Paris,2026-01-01T00:00:00.000Z,"[{""sku"":""sku-0"",""qty"":2}]"',
      '3,open,Paris,2026-01-03T00:00:00.000Z,"[{""sku"":""sku-2"",""qty"":2}]"',
      '',
    ]);
    await importCollection(mongo, { db, collection: 'from_csv' }, fileSource(path), {
      format: 'csv',
    });
    const [first] = await all(mongo, db, 'from_csv');
    expect(EJSON.parse(first!, { relaxed: false })).toEqual({
      _id: new Int32(1),
      status: 'open',
      customer: { address: { city: 'Paris' } },
      at: new Date('2026-01-01T00:00:00.000Z'),
      items: [{ sku: 'sku-0', qty: new Int32(2) }],
    });
  });

  it('upserts by _id, and reports the document a unique index refuses', async () => {
    const collection = 'upserts';
    await mongo.insertMany({ db, collection }, toEjson([{ _id: 1, v: 'old', key: 'a' }]));
    await mongo.createIndex(
      { db, collection },
      { keys: '{"key": 1}', name: 'key_1', unique: true },
    );
    const file = [
      { _id: 1, v: 'new', key: 'a' },
      { _id: 2, v: 'added', key: 'b' },
      { _id: 3, v: 'clash', key: 'b' },
      { _id: 4, v: 'after', key: 'c' },
    ]
      .map((doc) => toEjson(doc))
      .join('\n');
    const path = join(work, 'upserts.jsonl');
    await writeFile(path, file);
    const result = await importCollection(mongo, { db, collection }, fileSource(path), {
      format: 'jsonl',
      mode: 'upsert',
      onError: 'skip',
    });
    expect(result).toMatchObject({ read: 4, written: 3, skipped: 1 });
    expect(result.errors).toEqual([{ row: 3, message: expect.stringMatching(/duplicate key/) }]);
    expect(
      (await all(mongo, db, collection)).map((text) => EJSON.parse(text, { relaxed: true })),
    ).toEqual([
      { _id: 1, v: 'new', key: 'a' },
      { _id: 2, v: 'added', key: 'b' },
      { _id: 4, v: 'after', key: 'c' },
    ]);
  });
});
