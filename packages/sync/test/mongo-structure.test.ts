import { schemaSnapshotSchema } from '@querybara/core';
import type { SchemaSnapshot } from '@querybara/core';
import { indexDef } from '@querybara/driver-mongodb';
import { Double, Int32, isBsonDocument, parseShell, toEjson } from '@querybara/mongo-tools';
import { describe, expect, it } from 'vitest';

import { compareSchemas, generateScript, missingDependencies, setOperationSelected } from '../src';
import type { SchemaDiff } from '../src';

/** A collection as the driver's introspection reports it. */
function collection(
  name: string,
  options: Record<string, unknown> = {},
  indexes: Record<string, unknown>[] = [],
): Record<string, unknown> {
  const text: Record<string, string> = {};
  for (const [k, v] of Object.entries(options)) {
    text[k] =
      typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
        ? String(v)
        : toEjson(v);
  }
  return {
    name,
    kind: 'table',
    columns: [],
    primaryKey: { name: '_id_', columns: ['_id'] },
    indexes: indexes.map((spec) => indexDef({ v: 2, ...spec })),
    options: text,
  };
}

function view(name: string, viewOn: string, pipeline: unknown[]): Record<string, unknown> {
  return {
    name,
    materialized: false,
    definition: toEjson(pipeline),
    columns: [],
    options: { viewOn },
    indexes: [],
  };
}

function db(
  database: string,
  tables: Record<string, unknown>[],
  views: Record<string, unknown>[] = [],
): SchemaSnapshot {
  return schemaSnapshotSchema.parse({
    engine: 'mongodb',
    serverVersion: '8.0.4',
    database,
    capturedAt: '2026-01-01T00:00:00Z',
    schemas: [{ name: database, tables, views }],
  });
}

const ops = (diff: SchemaDiff): string[] => diff.operations.map((op) => op.id);

/** Every statement is a command document whose first key names the command. */
function commands(diff: SchemaDiff): string[] {
  return generateScript(diff, { include: 'all' }).statements.map((text) => {
    const doc = parseShell(text);
    expect(isBsonDocument(doc)).toBe(true);
    return Object.keys(doc as object)[0]!;
  });
}

const users = (extra: Record<string, unknown>[] = []): Record<string, unknown> =>
  collection('users', { validator: { $jsonSchema: { required: ['email'] } } }, [
    { key: { email: 1 }, name: 'email_1', unique: true },
    ...extra,
  ]);

describe('MongoDB structure compare', () => {
  it('finds nothing to do between identical databases, whatever the number types', () => {
    const a = db('app', [
      collection('users', { validator: { $jsonSchema: { minProperties: new Int32(1) } } }, [
        { key: { email: new Int32(1) }, name: 'email_1' },
      ]),
    ]);
    const b = db('app_test', [
      collection('users', { validator: { $jsonSchema: { minProperties: new Double(1) } } }, [
        { key: { email: new Double(1) }, name: 'email_1' },
      ]),
    ]);
    const { diff, summary } = compareSchemas(a, b);
    expect(diff.identical).toBe(true);
    expect(diff.dialect).toBe('mongodb');
    expect(summary.total).toBe(0);
    expect(generateScript(diff).statements).toEqual([]);
  });

  it('creates a missing collection with its options and indexes, then the views on it', () => {
    const source = db(
      'app',
      [users()],
      [view('active_users', 'users', [{ $match: { active: true } }])],
    );
    const { diff } = compareSchemas(source, db('app', []));
    expect(ops(diff)).toEqual(['collection:users:create', 'view:active_users:create']);
    const [create, createView] = diff.operations;
    expect(create!.steps.map((s) => s.statements.length)).toEqual([1, 1]);
    expect(createView!.dependsOn).toEqual(['collection:users:create']);
    expect(commands(diff)).toEqual(['create', 'createIndexes', 'create']);
    const script = generateScript(diff);
    expect(script.text).toContain('db = db.getSiblingDB("app");');
    expect(script.text).toContain("db.runCommand({ create: 'users', validator:");
    expect(script.text).toContain('// Create collection users');
    expect(script.transactional).toBe(false);
    expect(script.backupRecommended).toBe(true);
    expect(create!.sourceDdl).toContain(
      "db.users.createIndex({ email: 1 }, { name: 'email_1', unique: true })",
    );
  });

  it('drops extra collections and views only when ticked', () => {
    const { diff } = compareSchemas(db('app', []), db('app', [users()], [view('v', 'users', [])]));
    expect(ops(diff)).toEqual(['view:v:drop', 'collection:users:drop']);
    expect(diff.operations.every((op) => op.destructive && !op.selected)).toBe(true);
    expect(generateScript(diff).statements).toEqual([]);
    expect(commands(diff)).toEqual(['drop', 'drop']);
  });

  it('adds, drops, hides and rebuilds indexes', () => {
    const source = users([
      { key: { created: -1 }, name: 'created_-1', hidden: true },
      { key: { tenant: 1, name: 1 }, name: 'tenant_name' },
      { key: { last: 1 }, name: 'last_1', expireAfterSeconds: 60 },
    ]);
    const target = users([
      { key: { created: -1 }, name: 'created_-1' },
      { key: { name: 1, tenant: 1 }, name: 'tenant_name' },
      { key: { old: 1 }, name: 'old_1' },
      { key: { last: 1 }, name: 'last_1', expireAfterSeconds: 3600 },
    ]);
    const { diff } = compareSchemas(db('app', [source]), db('app', [target]));
    const byId = new Map(diff.operations.map((op) => [op.id, op]));
    expect([...byId.keys()].sort()).toEqual([
      'index:users.created_-1:alter',
      'index:users.last_1:alter',
      'index:users.old_1:drop',
      'index:users.tenant_name:alter',
    ]);
    expect(byId.get('index:users.created_-1:alter')!.statements).toEqual([
      "{ collMod: 'users', index: { name: 'created_-1', hidden: true } }",
    ]);
    expect(byId.get('index:users.last_1:alter')!.statements).toEqual([
      "{ collMod: 'users', index: { name: 'last_1', expireAfterSeconds: 60 } }",
    ]);
    // Key order matters: the compound index is dropped and created again, in that order.
    const rebuilt = byId.get('index:users.tenant_name:alter')!;
    expect(rebuilt.changes).toEqual(['key pattern']);
    expect(rebuilt.statements.map((s) => Object.keys(parseShell(s) as object)[0])).toEqual([
      'dropIndexes',
      'createIndexes',
    ]);
    expect(byId.get('index:users.old_1:drop')!.destructive).toBe(false);
  });

  it('matches indexes by definition when names are ignored', () => {
    const source = users([{ key: { a: 1 }, name: 'by_a' }]);
    const target = users([{ key: { a: 1 }, name: 'a_1' }]);
    expect(compareSchemas(db('x', [source]), db('x', [target])).diff.identical).toBe(false);
    const ignored = compareSchemas(db('x', [source]), db('x', [target]), { ignoreNames: true });
    expect(ignored.diff.identical).toBe(true);
  });

  it('drops an index before creating one with the same keys under another name', () => {
    const { diff } = compareSchemas(
      db('x', [users([{ key: { a: 1 }, name: 'by_a' }])]),
      db('x', [users([{ key: { a: 1 }, name: 'a_1' }])]),
    );
    expect(ops(diff)).toEqual(['index:users.a_1:drop', 'index:users.by_a:create']);
    const script = generateScript(diff, { include: 'all' });
    expect(script.statements.map((s) => Object.keys(parseShell(s) as object)[0])).toEqual([
      'dropIndexes',
      'createIndexes',
    ]);
  });

  it('changes validators and options with collMod, and flags what it cannot change', () => {
    const source = collection('events', {
      validator: { $jsonSchema: { required: ['at'] } },
      validationLevel: 'moderate',
      changeStreamPreAndPostImages: { enabled: true },
    });
    const target = collection('events', { validator: { $jsonSchema: { required: ['ts'] } } });
    const { diff } = compareSchemas(db('x', [source]), db('x', [target]));
    expect(ops(diff)).toEqual(['collection:events:alter']);
    const op = diff.operations[0]!;
    expect(op.changes).toEqual([
      'validator',
      'validationLevel: strict → moderate',
      'changeStreamPreAndPostImages: off → on',
    ]);
    const mod = parseShell(op.statements[0]!) as Record<string, unknown>;
    expect(Object.keys(mod)).toEqual([
      'collMod',
      'validator',
      'validationLevel',
      'changeStreamPreAndPostImages',
    ]);

    const capped = compareSchemas(
      db('x', [collection('log', { capped: true, size: 4096 })]),
      db('x', [collection('log')]),
    ).diff;
    expect(ops(capped)).toEqual(['collection:log:recreate']);
    const recreate = capped.operations[0]!;
    expect(recreate.statements).toEqual([]);
    expect(recreate.selected).toBe(false);
    expect(recreate.warnings.map((w) => w.code)).toEqual(['unsupported']);
    expect(generateScript(capped, { include: 'all' }).text).toContain('// Not scripted');
  });

  it('adds a validator without restating the default level and action', () => {
    const { diff } = compareSchemas(
      db('x', [collection('t', { validator: { a: { $exists: true } } })]),
      db('x', [collection('t')]),
    );
    expect(diff.operations[0]!.changes).toEqual(['validator added']);
    expect(Object.keys(parseShell(diff.operations[0]!.statements[0]!) as object)).toEqual([
      'collMod',
      'validator',
    ]);
  });

  it('removes a validator and resizes capped collections', () => {
    const { diff } = compareSchemas(
      db('x', [collection('log', { capped: true, size: 8192, max: 100 }), collection('t')]),
      db('x', [
        collection('log', { capped: true, size: 4096 }),
        collection('t', { validator: { a: { $exists: true } }, validationAction: 'warn' }),
      ]),
    );
    const byId = new Map(diff.operations.map((op) => [op.id, op]));
    expect(parseShell(byId.get('collection:t:alter')!.statements[0]!)).toEqual({
      collMod: 't',
      validator: {},
    });
    const resize = byId.get('collection:log:alter')!;
    expect(resize.statements).toEqual(["{ collMod: 'log', cappedSize: 8192, cappedMax: 100 }"]);
    // A new document cap removes the oldest documents beyond it.
    expect(resize.destructive).toBe(true);
  });

  it('changes a view pipeline in place and keeps views after what they read', () => {
    const { diff } = compareSchemas(
      db('x', [users()], [view('recent', 'users', [{ $sort: { created: -1 } }, { $limit: 10 }])]),
      db('x', [users()], [view('recent', 'users', [{ $sort: { created: 1 } }, { $limit: 10 }])]),
    );
    expect(ops(diff)).toEqual(['view:recent:alter']);
    expect(diff.operations[0]!.changes).toEqual(['pipeline']);
    expect(Object.keys(parseShell(diff.operations[0]!.statements[0]!) as object)).toEqual([
      'collMod',
      'viewOn',
      'pipeline',
    ]);
  });

  it('keeps a view on a new collection unticked when the collection is unticked', () => {
    const { diff } = compareSchemas(db('x', [users()], [view('v', 'users', [])]), db('x', []));
    const unticked = setOperationSelected(diff, 'collection:users:create', false);
    expect(unticked.operations.map((op) => [op.id, op.selected])).toEqual([
      ['collection:users:create', false],
      ['view:v:create', false],
    ]);
    expect(missingDependencies(unticked)).toEqual([]);
  });

  it('refuses to compare MongoDB with a SQL database', () => {
    const pg = schemaSnapshotSchema.parse({
      engine: 'postgres',
      database: 'app',
      capturedAt: '2026-01-01T00:00:00Z',
      schemas: [],
    });
    expect(() => compareSchemas(db('app', []), pg)).toThrow(/Cannot sync structure/);
  });
});
