import type {
  BsonDocument,
  BsonValue,
  DocumentPage,
  FindQuery,
  Namespace,
} from '@querybara/mongo-tools';
import {
  Binary,
  Decimal128,
  Double,
  EJSON,
  Int32,
  Long,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
  parseShell,
  toEjson,
} from '@querybara/mongo-tools';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  MongoDataSyncScriptBuilder,
  canonicalBson,
  compareBson,
  compareCollectionData,
  mongoScript,
} from '../src';
import type { MongoDataCompareOptions, MongoFindSession, RowDiff } from '../src';

/** One database in memory: find() sorts by _id and pages canonical Extended JSON. */
class FakeMongo implements MongoFindSession {
  readonly collections = new Map<string, BsonDocument[]>();
  queries: FindQuery[] = [];

  constructor(docs: Record<string, BsonDocument[]> = {}) {
    for (const [name, list] of Object.entries(docs)) this.collections.set(name, [...list]);
  }

  async *find(
    ns: Namespace,
    query: FindQuery,
    opts: { pageSize?: number } = {},
  ): AsyncIterable<DocumentPage> {
    this.queries.push(query);
    const docs = [...(this.collections.get(ns.collection) ?? [])].sort((a, b) =>
      compareBson(a['_id']!, b['_id']!),
    );
    const size = opts.pageSize ?? 1000;
    for (let i = 0; i < docs.length; i += size) {
      yield { documents: docs.slice(i, i + size).map(toEjson) };
    }
  }

  /** Runs one write command the way the server would. */
  run(text: string): void {
    const command = parseShell(text) as BsonDocument;
    const name = Object.keys(command)[0]!;
    const list = this.collections.get(String(command[name])) ?? [];
    this.collections.set(String(command[name]), list);
    const at = (id: BsonValue): number => list.findIndex((d) => compareBson(d['_id']!, id) === 0);
    if (name === 'insert') {
      for (const doc of command['documents'] as BsonDocument[]) {
        if (at(doc['_id']!) !== -1) throw new Error('duplicate key');
        list.push(doc);
      }
    } else if (name === 'delete') {
      for (const d of command['deletes'] as BsonDocument[]) {
        const i = at((d['q'] as BsonDocument)['_id']!);
        if (i !== -1) list.splice(i, 1);
      }
    } else if (name === 'update') {
      for (const u of command['updates'] as BsonDocument[]) {
        const i = at((u['q'] as BsonDocument)['_id']!);
        if (i === -1) list.push(u['u'] as BsonDocument);
        else list[i] = u['u'] as BsonDocument;
      }
    } else {
      throw new Error(`unexpected command ${name}`);
    }
  }
}

const ns = (collection: string): Namespace => ({ db: 'app', collection });

async function compare(
  source: FakeMongo,
  target: FakeMongo,
  options: MongoDataCompareOptions = {},
  ignoreFields?: string[],
) {
  const diffs: RowDiff[] = [];
  const gen = compareCollectionData(
    source,
    target,
    { source: ns('c'), target: ns('c'), ...(ignoreFields ? { ignoreFields } : {}) },
    options,
  );
  for (;;) {
    const next = await gen.next();
    if (next.done) return { diffs, summary: next.value };
    if (next.value.type === 'diff') diffs.push(next.value.diff);
  }
}

describe('BSON order', () => {
  it('sorts types and values the way MongoDB does', () => {
    const ordered: BsonValue[] = [
      new MinKey(),
      null,
      Number.NaN,
      -Infinity,
      new Int32(-5),
      new Double(1.5),
      new Long(2),
      Decimal128.fromString('2.5'),
      new Int32(3),
      'B',
      'a',
      'ab',
      { a: 1 },
      { a: 1, b: 1 },
      { b: 0 },
      [1, 2],
      new Binary(new Uint8Array([9]), 0),
      new Binary(new Uint8Array([1, 2]), 0),
      new ObjectId('000000000000000000000001'),
      new ObjectId('ffffffffffffffffffffffff'),
      false,
      true,
      new Date(0),
      new Date(1000),
      new Timestamp({ t: 1, i: 5 }),
      new Timestamp({ t: 2, i: 0 }),
      new MaxKey(),
    ];
    for (let i = 0; i < ordered.length; i++) {
      for (let j = 0; j < ordered.length; j++) {
        expect([i, j, Math.sign(compareBson(ordered[i]!, ordered[j]!))]).toEqual([
          i,
          j,
          Math.sign(i - j),
        ]);
      }
    }
    expect(compareBson(new Int32(1), new Double(1))).toBe(0);
    expect(compareBson(new Long('9007199254740993'), new Double(9007199254740992))).toBe(1);
  });

  it('gives equal canonical forms only to equal data', () => {
    expect(canonicalBson({ a: 1, b: 2 })).toBe(canonicalBson({ b: 2, a: 1 }));
    expect(canonicalBson({ a: 1, b: 2 }, { ignoreFieldOrder: false })).not.toBe(
      canonicalBson({ b: 2, a: 1 }, { ignoreFieldOrder: false }),
    );
    expect(canonicalBson(new Int32(1))).not.toBe(canonicalBson(new Double(1)));
    expect(canonicalBson(new Int32(1), { ignoreNumericTypes: true })).toBe(
      canonicalBson(new Long(1), { ignoreNumericTypes: true }),
    );
    expect(canonicalBson([1, 2])).not.toBe(canonicalBson([2, 1]));
    expect(canonicalBson('1')).not.toBe(canonicalBson(new Int32(1)));
  });
});

describe('compareCollectionData', () => {
  it('finds documents to insert, update and delete, with the fields that changed', async () => {
    const source = new FakeMongo({
      c: [
        { _id: new Int32(1), name: 'a', tags: ['x'] },
        { _id: new Int32(2), name: 'b', n: new Int32(5) },
        { _id: 'k', name: 'k' },
      ],
    });
    const target = new FakeMongo({
      c: [
        { _id: new Int32(2), name: 'b', n: new Double(5), extra: true },
        { _id: new Int32(3), name: 'c' },
        { _id: 'k', name: 'k' },
      ],
    });
    const { diffs, summary } = await compare(source, target);
    expect(diffs.map((d) => [d.action, d.key[0], d.changedColumns])).toEqual([
      ['insert', '{"$numberInt":"1"}', undefined],
      ['update', '{"$numberInt":"2"}', ['n', 'extra']],
      ['delete', '{"$numberInt":"3"}', undefined],
    ]);
    expect(summary).toEqual({
      inserts: 1,
      updates: 1,
      deletes: 1,
      equal: 1,
      sourceRows: 3,
      targetRows: 3,
    });
    expect(source.queries[0]).toMatchObject({
      sort: '{"_id":1}',
      collation: '{"locale":"simple"}',
      maxTimeMS: 0,
    });
    // Rows are the _id and the whole document, both canonical Extended JSON.
    expect(EJSON.parse(String(diffs[0]!.sourceRow![1]), { relaxed: false })).toEqual({
      _id: new Int32(1),
      name: 'a',
      tags: ['x'],
    });
  });

  it('ignores field order and ignored fields, and number types on request', async () => {
    const source = new FakeMongo({ c: [{ _id: 1, a: 1, b: new Int32(2), at: new Date(1) }] });
    const target = new FakeMongo({ c: [{ _id: 1, b: new Double(2), a: 1, at: new Date(2) }] });
    expect((await compare(source, target)).diffs[0]!.changedColumns).toEqual(['b', 'at']);
    expect((await compare(source, target, {}, ['at'])).diffs[0]!.changedColumns).toEqual(['b']);
    expect(
      (await compare(source, target, { ignoreNumericTypes: true }, ['at'])).summary.equal,
    ).toBe(1);
    const strict = await compare(
      source,
      target,
      {
        ignoreNumericTypes: true,
        ignoreFieldOrder: false,
      },
      ['at'],
    );
    expect(strict.diffs[0]!.changedColumns).toEqual(['(field order)']);
  });

  it('reads both sides page by page and refuses documents out of _id order', async () => {
    const many = Array.from({ length: 2500 }, (_v, i) => ({ _id: i, v: i }));
    const { summary } = await compare(new FakeMongo({ c: many }), new FakeMongo({ c: many }), {
      pageSize: 100,
    });
    expect(summary).toMatchObject({ equal: 2500, sourceRows: 2500, targetRows: 2500 });

    const unsorted: MongoFindSession = {
      async *find() {
        yield { documents: [toEjson({ _id: 2 }), toEjson({ _id: 1 })] };
      },
    };
    await expect(compare(unsorted as FakeMongo, new FakeMongo())).rejects.toThrow(
      /did not come back in _id order/,
    );
  });
});

describe('MongoDataSyncScriptBuilder', () => {
  it('batches commands that keep every BSON type', () => {
    const builder = new MongoDataSyncScriptBuilder({ collection: 'c', batchSize: 2 });
    const doc = (id: number): string =>
      toEjson({ _id: new Long(id), at: new Date(0), d: Decimal128.fromString('1.10') });
    const statements = [
      ...builder.add({ action: 'insert', key: ['x'], sourceRow: ['x', doc(1)] }),
      ...builder.add({ action: 'insert', key: ['x'], sourceRow: ['x', doc(2)] }),
      ...builder.add({ action: 'insert', key: ['x'], sourceRow: ['x', doc(3)] }),
      ...builder.add({
        action: 'delete',
        key: [toEjson(new ObjectId('64b7f0000000000000000001'))],
      }),
      ...builder.flush(),
    ];
    expect(statements.map((s) => Object.keys(parseShell(s) as object)[0])).toEqual([
      'insert',
      'insert',
      'delete',
    ]);
    const first = parseShell(statements[0]!) as BsonDocument;
    expect((first['documents'] as BsonDocument[])[0]).toEqual({
      _id: new Long(1),
      at: new Date(0),
      d: Decimal128.fromString('1.10'),
    });
    expect(parseShell(statements[2]!)).toEqual({
      delete: 'c',
      deletes: [{ q: { _id: new ObjectId('64b7f0000000000000000001') }, limit: new Int32(1) }],
    });
    const script = mongoScript('app', statements.slice(2));
    expect(script.startsWith('db = db.getSiblingDB("app");\n')).toBe(true);
    expect(script).toContain('function sync(command) {');
    expect(script.endsWith(`\nsync(${statements[2]});`)).toBe(true);
  });

  it('makes the target equal to the source (property)', async () => {
    const value = fc.oneof(
      fc.integer().map((n) => new Int32(n)),
      fc.double({ noNaN: true }).map((n) => new Double(n)),
      fc.string(),
      fc.boolean(),
      fc.constant(null),
    );
    const id = fc.oneof(
      fc.integer({ min: 0, max: 30 }).map((n) => new Int32(n)),
      fc.constantFrom('a', 'b', 'c').map((s) => s as BsonValue),
      fc
        .constantFrom('64b7f0000000000000000001', '64b7f0000000000000000002')
        .map((h) => new ObjectId(h)),
    );
    const docs = fc
      .uniqueArray(fc.tuple(id, fc.dictionary(fc.constantFrom('a', 'b', 'c'), value)), {
        selector: ([i]) => toEjson(i),
        maxLength: 25,
      })
      .map((entries) => entries.map(([i, rest]) => ({ _id: i, ...rest }) as BsonDocument));
    await fc.assert(
      fc.asyncProperty(docs, docs, async (a, b) => {
        const source = new FakeMongo({ c: a });
        const target = new FakeMongo({ c: b });
        const { diffs } = await compare(source, target, { pageSize: 7 });
        const builder = new MongoDataSyncScriptBuilder({ collection: 'c', batchSize: 3 });
        for (const action of ['delete', 'update', 'insert'] as const) {
          for (const diff of diffs.filter((d) => d.action === action)) {
            for (const statement of builder.add(diff)) target.run(statement);
          }
          for (const statement of builder.flush()) target.run(statement);
        }
        const after = await compare(source, target, { ignoreFieldOrder: false });
        expect(after.diffs).toEqual([]);
      }),
      { numRuns: 60 },
    );
  });
});
