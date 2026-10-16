import { randomBytes } from 'node:crypto';

import { connectionProfileSchema } from '@querybara/core';
import type { SchemaSnapshot } from '@querybara/core';
import {
  isMongoSession,
  mongodbAdapter,
  parseHostList,
  splitMongoUri,
  type MongoSession,
} from '@querybara/driver-mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  MongoDataSyncScriptBuilder,
  compareCollectionData,
  compareSchemas,
  generateScript,
  runMongoCommand,
} from '../../src';
import type { RowDiff } from '../../src';

/**
 * MongoDB structure and data sync against a real server (QUERYBARA_TEST_MONGODB_URL, CI's
 * replica set): every generated command runs, and a re-compare afterwards finds nothing.
 */

const URL = process.env['QUERYBARA_TEST_MONGODB_URL'];

async function connect(url: string, database: string): Promise<MongoSession> {
  const parts = splitMongoUri(url);
  const params = new URLSearchParams(parts.query);
  const hosts = parseHostList(parts.hosts);
  const replicaSet = params.get('replicaSet') ?? undefined;
  const now = new Date().toISOString();
  const profile = connectionProfileSchema.parse({
    id: `test-${database}`,
    name: 'Test MongoDB',
    engine: 'mongodb',
    endpoint: replicaSet
      ? { kind: 'hosts', hosts, replicaSet }
      : { kind: 'host', host: hosts[0]!.host, port: hosts[0]!.port },
    auth: {
      method: 'password',
      ...(parts.user ? { user: parts.user } : {}),
      ...(parts.password ? { password: { id: 'password' } } : {}),
    },
    tls: { mode: 'disable' },
    createdAt: now,
    updatedAt: now,
    options: { authSource: params.get('authSource') ?? 'admin', defaultDatabase: database },
  });
  const session = await mongodbAdapter.connect({
    profile,
    secrets: parts.password ? { password: parts.password } : {},
  });
  if (!isMongoSession(session)) throw new Error('expected a MongoSession');
  return session;
}

const run = (session: MongoSession, commands: readonly string[]): Promise<unknown> =>
  commands.reduce<Promise<unknown>>(
    (previous, text) => previous.then(() => runMongoCommand(session, text)),
    Promise.resolve(),
  );

const snapshot = (session: MongoSession, database: string): Promise<SchemaSnapshot> =>
  session.introspect({ database });

describe.skipIf(!URL)('MongoDB sync round trip', () => {
  const suffix = randomBytes(4).toString('hex');
  const names = { source: `querybara_sync_src_${suffix}`, target: `querybara_sync_tgt_${suffix}` };
  let source: MongoSession;
  let target: MongoSession;

  beforeAll(async () => {
    source = await connect(URL!, names.source);
    target = await connect(URL!, names.target);
  });

  afterAll(async () => {
    for (const [session, name] of [
      [source, names.source],
      [target, names.target],
    ] as const) {
      await session?.dropDatabase(name).catch(() => undefined);
      await session?.close();
    }
  });

  it('makes the target structure match the source', async () => {
    await run(source, [
      `{ create: 'users', validator: { $jsonSchema: { bsonType: 'object', required: ['email'] } }, validationLevel: 'moderate' }`,
      `{ createIndexes: 'users', indexes: [
          { key: { email: 1 }, name: 'email_1', unique: true },
          { key: { tenant: 1, created: -1 }, name: 'tenant_created', partialFilterExpression: { active: true } },
          { key: { bio: 'text' }, name: 'bio_text', weights: { bio: 5 } },
          { key: { seen: 1 }, name: 'seen_ttl', expireAfterSeconds: 3600, hidden: true }
        ] }`,
      `{ create: 'log', capped: true, size: 65536, max: 1000 }`,
      `{ create: 'events', changeStreamPreAndPostImages: { enabled: true } }`,
      `{ create: 'active_users', viewOn: 'users', pipeline: [{ $match: { active: true } }, { $project: { email: 1 } }] }`,
      `{ create: 'recent_active', viewOn: 'active_users', pipeline: [{ $limit: 5 }] }`,
    ]);
    await run(target, [
      `{ create: 'users', validator: { email: { $type: 'string' } } }`,
      `{ createIndexes: 'users', indexes: [
          { key: { email: 1 }, name: 'email_1' },
          { key: { created: -1, tenant: 1 }, name: 'tenant_created' },
          { key: { legacy: 1 }, name: 'legacy_1' },
          { key: { seen: 1 }, name: 'seen_ttl', expireAfterSeconds: 60 }
        ] }`,
      `{ create: 'log', capped: true, size: 32768 }`,
      `{ create: 'obsolete' }`,
      `{ create: 'active_users', viewOn: 'users', pipeline: [{ $match: { active: false } }] }`,
    ]);

    const { diff } = compareSchemas(
      await snapshot(source, names.source),
      await snapshot(target, names.target),
    );
    expect(diff.dialect).toBe('mongodb');
    expect(diff.operations.map((op) => op.id).sort()).toEqual([
      'collection:events:create',
      'collection:log:alter',
      'collection:obsolete:drop',
      'collection:users:alter',
      'index:users.bio_text:create',
      'index:users.email_1:alter',
      'index:users.legacy_1:drop',
      'index:users.seen_ttl:alter',
      'index:users.tenant_created:alter',
      'view:active_users:alter',
      'view:recent_active:create',
    ]);

    const script = generateScript(diff, { include: 'all' });
    await run(target, script.statements);

    const after = compareSchemas(
      await snapshot(source, names.source),
      await snapshot(target, names.target),
    ).diff;
    expect(after.operations.map((op) => `${op.id}: ${op.changes.join(', ')}`)).toEqual([]);
  });

  it('copies documents so that a second compare finds no differences', async () => {
    await run(source, [
      `{ create: 'people', collation: { locale: 'en', strength: 2 } }`,
      `{ insert: 'people', documents: [
          { _id: 1, name: 'one', n: NumberInt(1) },
          { _id: 'B', name: 'upper b', tags: ['x', 'y'] },
          { _id: 'a', name: 'lower a', at: ISODate('2024-05-01T10:00:00Z') },
          { _id: ObjectId('64b7f0000000000000000001'), nested: { z: 1, a: NumberDecimal('1.10') } },
          { _id: 2.5, big: NumberLong('9007199254740993') },
          { _id: { k: 1 }, v: null }
        ] }`,
    ]);
    await run(target, [
      `{ create: 'people', collation: { locale: 'en', strength: 2 } }`,
      `{ createIndexes: 'people', indexes: [{ key: { name: 1 }, name: 'name_1', unique: true, sparse: true }] }`,
      `{ insert: 'people', documents: [
          { _id: 1, name: 'one', n: 1.0 },
          { _id: 'a', name: 'lower a', at: ISODate('2024-05-01T10:00:01Z') },
          { _id: 'c', name: 'only in target' },
          { _id: ObjectId('64b7f0000000000000000001'), nested: { a: NumberDecimal('1.10'), z: 1 } },
          { _id: 2.5, big: NumberLong('9007199254740993') }
        ] }`,
    ]);

    const compare = async (): Promise<RowDiff[]> => {
      const diffs: RowDiff[] = [];
      for await (const event of compareCollectionData(
        source,
        target,
        {
          source: { db: names.source, collection: 'people' },
          target: { db: names.target, collection: 'people' },
        },
        { pageSize: 2 },
      )) {
        if (event.type === 'diff') diffs.push(event.diff);
      }
      return diffs;
    };
    const diffs = await compare();
    expect(diffs.map((d) => [d.action, d.key[0], d.changedColumns ?? []])).toEqual([
      ['update', '{"$numberInt":"1"}', ['n']],
      ['insert', '"B"', []],
      ['update', '"a"', ['at']],
      ['delete', '"c"', []],
      ['insert', '{"k":{"$numberInt":"1"}}', []],
    ]);

    const builder = new MongoDataSyncScriptBuilder({ collection: 'people', batchSize: 2 });
    const statements: string[] = [];
    for (const action of ['delete', 'update', 'insert'] as const) {
      for (const diff of diffs.filter((d) => d.action === action))
        statements.push(...builder.add(diff));
      statements.push(...builder.flush());
    }
    await run(target, statements);
    expect(await compare()).toEqual([]);
  });

  it('reports a write the target refuses', async () => {
    await run(target, [
      `{ create: 'strict', validator: { $jsonSchema: { required: ['must'] } } }`,
      `{ insert: 'strict', documents: [{ _id: 1, must: true }] }`,
    ]);
    await expect(
      runMongoCommand(target, `{ insert: 'strict', documents: [{ _id: 2 }] }`),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(
      runMongoCommand(
        target,
        `{ insert: 'strict', documents: [{ _id: 3, must: 1 }, { _id: 1, must: 1 }] }`,
      ),
    ).rejects.toThrow(/duplicate key.*\(document 2 of the command\)/);
  });
});
