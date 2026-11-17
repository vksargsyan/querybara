import { Readable } from 'node:stream';

import type { ConnectionCheckResult } from '@querybara/core';
import { EJSON, parseShellDocument, toFindQuery, type ShellEvent } from '@querybara/mongo-tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkConnection, connectMongoClient, type MongoSession } from '../../src';
import { MongoDbSession } from '../../src/session';
import { ShellRuntime } from '../../src/shell';
import { drain, mongoProfile, testDatabase } from './helpers';

/**
 * MongoDB 4.2 (a standalone, like most servers still on it), which only the legacy driver
 * speaks: the session moves to it at the handshake, and documents, commands, indexes, the
 * structure, GridFS and the shell work through it.
 */
const URL = process.env['QUERYBARA_TEST_MONGODB_42_URL'];

describe.skipIf(!URL)('MongoDB 4.2 through the legacy driver', () => {
  const db = testDatabase();
  const items = { db, collection: 'items' };
  let session: MongoSession;

  beforeAll(async () => {
    session = await MongoDbSession.open(mongoProfile(URL!));
  });

  afterAll(async () => {
    await session?.dropDatabase(db).catch(() => undefined);
    await session?.close();
  });

  it('connects through the legacy driver and passes Test Connection', async () => {
    expect(session.serverVersion).toMatch(/^4\.2\./);
    expect((session as MongoDbSession).driverRelease).toBe('legacy');
    const steps: ConnectionCheckResult[] = [];
    for await (const step of checkConnection(mongoProfile(URL!))) steps.push(step);
    expect(steps.filter((s) => s.status === 'failed')).toEqual([]);
    expect(steps.at(-1)?.message).toMatch(
      /^MongoDB 4\.2\.\d+, standalone; through the driver kept for MongoDB 4\.2$/,
    );
  });

  it('writes, finds, counts and aggregates documents, keeping their BSON types', async () => {
    await session.insertMany(
      items,
      `[${Array.from(
        { length: 30 },
        (_, i) =>
          `{ _id: ${i}, kind: '${i % 2 === 0 ? 'even' : 'odd'}', qty: NumberLong(${i}), price: NumberDecimal('${i}.50'), at: ISODate('2026-01-01T00:00:00Z'), ref: ObjectId('65a1b2c3d4e5f60718293a4b') }`,
      ).join(',')}]`,
    );
    const query = toFindQuery({
      filter: parseShellDocument("{ kind: 'even', qty: { $gte: NumberLong(10) } }"),
      sort: parseShellDocument('{ qty: -1 }'),
      limit: 3,
    });
    const docs = await drain(session.find(items, query));
    expect(docs).toHaveLength(3);
    expect(docs[0]).toContain('"qty":{"$numberLong":"28"}');
    expect(docs[0]).toContain('"price":{"$numberDecimal":"28.50"}');
    expect(docs[0]).toContain('"ref":{"$oid":"65a1b2c3d4e5f60718293a4b"}');
    expect(
      await session.updateMany(items, "{ kind: 'odd' }", '{ $set: { seen: true } }'),
    ).toMatchObject({ matchedCount: 15, modifiedCount: 15 });
    expect(await session.count(items, '{ "seen": true }')).toBe(15);
    const groups = await drain(
      session.aggregate(
        items,
        `[{ $group: { _id: '$kind', n: { $sum: 1 } } }, { $sort: { _id: 1 } }]`,
      ),
    );
    expect(groups.map((g) => EJSON.parse(g))).toEqual([
      { _id: 'even', n: 15 },
      { _id: 'odd', n: 15 },
    ]);
  });

  it('runs commands from the editor', async () => {
    await session.useDatabase(db);
    const chunks = [];
    for await (const chunk of session.execute(`{ count: 'items', query: { kind: 'even' } }`, {
      executionId: 'legacy-count',
    })) {
      chunks.push(chunk);
    }
    expect(JSON.stringify(chunks)).toContain('{\\"n\\":{\\"$numberInt\\":\\"15\\"}');
  });

  it('creates and lists indexes, browses and introspects the structure', async () => {
    await session.createIndex(items, { keys: '{ "kind": 1, "qty": -1 }', name: 'kind_qty' });
    await session.createIndex(items, { keys: '{ "ref": 1 }', unique: false, sparse: true });
    expect((await session.listIndexes(items)).map((i) => i.name)).toEqual(
      expect.arrayContaining(['_id_', 'kind_qty', 'ref_1']),
    );
    const collections = await session.browse([db, 'collections']);
    expect(collections.map((n) => n.name)).toContain('items');
    const snapshot = await session.introspect({ database: db });
    const table = snapshot.schemas[0]!.tables.find((t) => t.name === 'items')!;
    expect(table.indexes.map((i) => i.name).sort()).toEqual(['kind_qty', 'ref_1']);
  });

  it('uploads, lists and downloads GridFS files', async () => {
    const bucket = { db, bucket: 'files' };
    const body = Buffer.alloc(300_000, 7);
    const id = await session.uploadFile(bucket, Readable.from([body]), { filename: 'a.bin' });
    const files = (await drain(
      (async function* () {
        for await (const page of session.listFiles(bucket)) yield { documents: page.files };
      })(),
    )) as { filename: string }[];
    expect(files.map((f) => f.filename)).toEqual(['a.bin']);
    const chunks: Uint8Array[] = [];
    for await (const chunk of session.downloadFile(bucket, id)) chunks.push(chunk);
    expect(Buffer.concat(chunks).equals(body)).toBe(true);
  });

  it('runs the embedded shell on the legacy client', async () => {
    const { client } = await connectMongoClient(mongoProfile(URL!));
    try {
      const shell = await ShellRuntime.open({
        client,
        database: db,
        policy: { connectionName: 'Test', readOnly: false, confirmWrites: false },
      });
      const events: ShellEvent[] = [];
      await shell.evaluate("db.items.countDocuments({ kind: 'even' })", {
        emit: (event) => events.push(event),
        ask: async () => ({ kind: 'deny' }),
      });
      expect(events.filter((e) => e.type === 'error')).toEqual([]);
      expect(JSON.stringify(events)).toContain('15');
    } finally {
      await client.close();
    }
  });
});
