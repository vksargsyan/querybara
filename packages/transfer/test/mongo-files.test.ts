import { QuerybaraError } from '@querybara/core';
import {
  Decimal128,
  Double,
  Int32,
  Long,
  ObjectId,
  fromEjson,
  isBsonDocument,
  toEjson,
  type BsonDocument,
  type FindQuery,
  type Namespace,
} from '@querybara/mongo-tools';
import { describe, expect, it } from 'vitest';

import {
  bytesSource,
  documentFields,
  exportCollection,
  importCollection,
  inferCsvValue,
  jsonValues,
  memorySink,
  mongoFileFormat,
  readDocuments,
  type MongoTransferSession,
} from '../src';

/**
 * MongoDB collections to and from files (ADR 0037): JSON, JSON Lines, CSV and BSON written from
 * a find(), read back with every BSON type, and imported in the insert, upsert and replace modes.
 */

const NS: Namespace = { db: 'shop', collection: 'orders' };

/** An in-memory collection behind the transfer session's MongoDB methods. */
function fakeMongo(initial: BsonDocument[] = []) {
  let stored = initial.map((doc) => toEjson(doc));
  const idOf = (text: string): string | undefined => {
    const doc = fromEjson(text) as BsonDocument;
    return doc['_id'] === undefined ? undefined : toEjson(doc['_id']);
  };
  const writeError = (index: number, message: string): QuerybaraError =>
    new QuerybaraError(
      { code: 'CONFLICT', message },
      { cause: { writeErrors: [{ index, errmsg: message }] } },
    );
  const session = {
    engine: 'mongodb',
    currentDatabase: 'shop',
    async *find(_ns: Namespace, query: FindQuery, opts?: { pageSize?: number }) {
      const size = opts?.pageSize ?? 1000;
      const docs = query.limit ? stored.slice(0, query.limit) : stored;
      for (let i = 0; i < docs.length; i += size) {
        yield { documents: docs.slice(i, i + size), hasMore: i + size < docs.length };
      }
    },
    async insertMany(_ns: Namespace, text: string) {
      const docs = (fromEjson(text) as BsonDocument[]).map((doc) => toEjson(doc));
      const ids = new Set(stored.map(idOf));
      for (let i = 0; i < docs.length; i++) {
        const id = idOf(docs[i]!);
        if (id !== undefined && ids.has(id)) {
          stored.push(...docs.slice(0, i));
          throw writeError(i, `E11000 duplicate key error: _id ${id}`);
        }
        ids.add(id);
      }
      stored.push(...docs);
      return { insertedCount: docs.length, insertedIds: [] };
    },
    async upsertMany(_ns: Namespace, text: string) {
      const docs = (fromEjson(text) as BsonDocument[]).map((doc) => toEjson(doc));
      let matched = 0;
      for (const doc of docs) {
        const id = idOf(doc);
        const at = id === undefined ? -1 : stored.findIndex((d) => idOf(d) === id);
        if (at >= 0) {
          stored[at] = doc;
          matched++;
        } else stored.push(doc);
      }
      return { matchedCount: matched, modifiedCount: matched, upsertedCount: 0, insertedCount: 0 };
    },
    async deleteMany() {
      const deletedCount = stored.length;
      stored = [];
      return { dryRun: false, matchedCount: deletedCount, modifiedCount: 0, deletedCount };
    },
  };
  return {
    session: session as unknown as MongoTransferSession,
    documents: () => stored.map((text) => fromEjson(text) as BsonDocument),
  };
}

const ORDER: BsonDocument = {
  _id: new Int32(1),
  status: 'open',
  big: Long.fromString('9007199254740993'),
  price: Decimal128.fromString('10.50'),
  at: new Date('2026-01-02T03:04:05.000Z'),
  ref: new ObjectId('65a1b2c3d4e5f60718293a4b'),
  customer: { name: 'Ada', address: { city: 'Paris' } },
  tags: ['red', 'big'],
  note: null,
};

async function exported(
  format: 'json' | 'jsonl' | 'csv' | 'bson' | 'sql',
  docs: BsonDocument[],
  options: Record<string, unknown> = {},
): Promise<Uint8Array> {
  const { session } = fakeMongo(docs);
  const sink = memorySink();
  await exportCollection(session, NS, {}, sink, { format, pageSize: 2, ...options });
  return sink.bytes();
}

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
}

/** Text in one-character chunks, so every value crosses a chunk boundary. */
async function* chars(value: string): AsyncGenerator<string> {
  for (const c of value) yield c;
}

describe('mongoFileFormat', () => {
  it('reads the format from the file name', () => {
    expect(mongoFileFormat('orders.json')).toBe('json');
    expect(mongoFileFormat('orders.JSONL')).toBe('jsonl');
    expect(mongoFileFormat('orders.ndjson.gz')).toBe('jsonl');
    expect(mongoFileFormat('orders.csv')).toBe('csv');
    expect(mongoFileFormat('dump/shop/orders.bson')).toBe('bson');
    expect(mongoFileFormat('orders.xlsx')).toBeUndefined();
  });
});

describe('jsonValues', () => {
  it('splits an array, JSON Lines and pretty documents one after another', async () => {
    const values = async (input: string) =>
      (await collect(jsonValues(chars(input)))).map((v) => [v.text, v.line]);
    expect(await values('[\n {"a":1},\n {"b":"]}"}\n]\n')).toEqual([
      ['{"a":1}', 2],
      ['{"b":"]}"}', 3],
    ]);
    expect(await values('{"a":1}\n{"a":2}\n')).toEqual([
      ['{"a":1}', 1],
      ['{"a":2}', 2],
    ]);
    expect(await values('{\n  "a": [1, {"b": "\\"}"}]\n}\n{\n  "a": 2\n}')).toEqual([
      ['{\n  "a": [1, {"b": "\\"}"}]\n}', 1],
      ['{\n  "a": 2\n}', 4],
    ]);
    expect(await values('[1, "x", {"a":1}]')).toEqual([
      ['1', 1],
      ['"x"', 1],
      ['{"a":1}', 1],
    ]);
    expect(await values('\uFEFF[]')).toEqual([]);
    expect(await values('{"a":')).toEqual([['{"a":', 1]]);
  });
});

describe('export and read back', () => {
  it('keeps every type through JSON, JSON Lines (relaxed and canonical) and BSON', async () => {
    for (const [format, options] of [
      ['json', {}],
      ['json', { pretty: true }],
      ['jsonl', {}],
      ['jsonl', { ejson: 'canonical' }],
      ['bson', {}],
    ] as const) {
      const bytes = await exported(format, [ORDER, { _id: new Int32(2) }], options);
      const read = await collect(readDocuments(bytesSource(bytes), { format }));
      expect(
        read.map((item) => toEjson(item.document)),
        `${format} ${JSON.stringify(options)}`,
      ).toEqual([toEjson(ORDER), toEjson({ _id: new Int32(2) })]);
    }
  });

  it('writes JSON as an indented array and JSON Lines one document per line', async () => {
    expect(text(await exported('json', [{ _id: new Int32(1) }, { _id: new Int32(2) }]))).toBe(
      '[\n  {"_id":1},\n  {"_id":2}\n]\n',
    );
    expect(text(await exported('json', []))).toBe('[]\n');
    expect(text(await exported('jsonl', [ORDER]))).toBe(
      '{"_id":1,"status":"open","big":{"$numberLong":"9007199254740993"},"price":{"$numberDecimal":"10.50"},"at":{"$date":"2026-01-02T03:04:05.000Z"},"ref":{"$oid":"65a1b2c3d4e5f60718293a4b"},"customer":{"name":"Ada","address":{"city":"Paris"}},"tags":["red","big"],"note":null}\n',
    );
  });

  it('writes CSV with the fields of the documents, sub-document fields dotted', async () => {
    const csv = text(await exported('csv', [ORDER, { _id: new Int32(2), status: 'a,b' }]));
    expect(csv).toBe(
      [
        '_id,status,big,price,at,ref,customer.name,customer.address.city,tags,note',
        '1,open,9007199254740993,10.50,2026-01-02T03:04:05.000Z,65a1b2c3d4e5f60718293a4b,Ada,Paris,"[""red"",""big""]",',
        '2,"a,b",,,,,,,,',
        '',
      ].join('\r\n'),
    );
    const chosen = text(
      await exported('csv', [ORDER], {
        fields: ['customer.address.city', '_id'],
        csv: { delimiter: ';', lineEnding: '\n' },
      }),
    );
    expect(chosen).toBe('customer.address.city;_id\nParis;1\n');
    expect(
      text(await exported('csv', [ORDER], { fields: ['status'], csv: { header: false } })),
    ).toBe('open\r\n');
  });

  it('writes SQL INSERT statements, with a CREATE TABLE typed from the first documents', async () => {
    const sql = text(
      await exported('sql', [ORDER, { _id: new Int32(2), status: "it's", big: Long.fromInt(3) }], {
        sql: { table: 'orders "x"', createTable: true },
      }),
    );
    const table = '"orders ""x"""';
    const columns =
      '"_id", "status", "big", "price", "at", "ref", "customer.name", "customer.address.city", "tags", "note"';
    expect(sql).toBe(
      [
        `CREATE TABLE ${table} (`,
        '  "_id" BIGINT,',
        '  "status" TEXT,',
        '  "big" BIGINT,',
        '  "price" NUMERIC,',
        '  "at" TIMESTAMP,',
        '  "ref" TEXT,',
        '  "customer.name" TEXT,',
        '  "customer.address.city" TEXT,',
        '  "tags" TEXT,',
        '  "note" TEXT',
        ');',
        `INSERT INTO ${table} (${columns}) VALUES (1, 'open', 9007199254740993, 10.50, '2026-01-02 03:04:05.000', '65a1b2c3d4e5f60718293a4b', 'Ada', 'Paris', '["red","big"]', NULL);`,
        `INSERT INTO ${table} (${columns}) VALUES (2, 'it''s', 3, NULL, NULL, NULL, NULL, NULL, NULL, NULL);`,
        '',
      ].join('\n'),
    );
    // Chosen fields, no CREATE TABLE, the collection's name for the table.
    expect(text(await exported('sql', [ORDER], { fields: ['status', 'at'] }))).toBe(
      `INSERT INTO "orders" ("status", "at") VALUES ('open', '2026-01-02 03:04:05.000');\n`,
    );
  });

  it('reads CSV back into documents, inferring types and nesting dotted fields', async () => {
    const csv = text(await exported('csv', [ORDER]));
    const [item] = await collect(readDocuments(bytesSource(csv), { format: 'csv' }));
    expect(item?.document).toEqual({
      _id: new Int32(1),
      status: 'open',
      big: Long.fromString('9007199254740993'),
      price: new Double(10.5),
      at: new Date('2026-01-02T03:04:05.000Z'),
      ref: '65a1b2c3d4e5f60718293a4b',
      customer: { name: 'Ada', address: { city: 'Paris' } },
      tags: ['red', 'big'],
    });
    const strings = await collect(
      readDocuments(bytesSource('a;b\n1;\n'), {
        format: 'csv',
        csv: { delimiter: ';', types: 'string', empty: 'null' },
      }),
    );
    expect(strings[0]?.document).toEqual({ a: '1', b: null });
    const headless = await collect(
      readDocuments(bytesSource('x,2\n'), {
        format: 'csv',
        csv: { header: false, empty: 'string' },
      }),
    );
    expect(headless[0]).toMatchObject({ row: 1, line: 1 });
    expect(toEjson(headless[0]?.document)).toBe('{"field1":"x","field2":{"$numberInt":"2"}}');
  });

  it('reports values that are not documents, with their row and line', async () => {
    const read = await collect(
      readDocuments(bytesSource('{"a":1}\n[1]\n{"a":\n'), { format: 'jsonl' }),
    );
    expect(read[0]?.document).toEqual({ a: new Int32(1) });
    expect(read[1]).toMatchObject({
      row: 2,
      line: 2,
      error: 'Not a document: each value must be an object',
    });
    expect(read[2]).toMatchObject({ row: 3, line: 3 });
    expect(read[2]?.error).toMatch(/^Not valid JSON/);
  });
});

describe('inferCsvValue', () => {
  it('reads plain values as their types and leaves the rest as text', () => {
    expect(inferCsvValue('true', 'a')).toBe(true);
    expect(toEjson(inferCsvValue('42', 'a'))).toBe('{"$numberInt":"42"}');
    expect(toEjson(inferCsvValue('3000000000', 'a'))).toBe('{"$numberLong":"3000000000"}');
    expect(toEjson(inferCsvValue('1.5', 'a'))).toBe('{"$numberDouble":"1.5"}');
    expect(inferCsvValue('007', 'a')).toBe('007');
    expect(inferCsvValue('2026-01-31', 'a')).toEqual(new Date('2026-01-31T00:00:00Z'));
    expect(inferCsvValue('2026-01-31 10:00:00+02:00', 'a')).toEqual(
      new Date('2026-01-31T08:00:00Z'),
    );
    expect(inferCsvValue('65a1b2c3d4e5f60718293a4b', '_id')).toEqual(
      new ObjectId('65a1b2c3d4e5f60718293a4b'),
    );
    expect(inferCsvValue('65a1b2c3d4e5f60718293a4b', 'ref')).toBe('65a1b2c3d4e5f60718293a4b');
    expect(inferCsvValue('{"a": 1}', 'a')).toEqual({ a: new Int32(1) });
    expect(inferCsvValue('{not json}', 'a')).toBe('{not json}');
    expect(inferCsvValue('Paris', 'a')).toBe('Paris');
  });
});

describe('documentFields', () => {
  it('lists dotted leaf fields in the order first seen, _id first', () => {
    expect(
      documentFields([
        { a: 1, _id: 1, b: { c: 1, d: { e: 1 } } },
        { f: [1], b: { c: 2, g: 1 }, empty: {} },
      ]),
    ).toEqual(['_id', 'a', 'b.c', 'b.d.e', 'f', 'b.g', 'empty']);
  });
});

describe('importCollection', () => {
  const lines = (...docs: BsonDocument[]): string => docs.map((d) => toEjson(d)).join('\n');

  it('inserts in batches and stops at a taken _id, or skips it and goes on', async () => {
    const file = lines({ _id: 1 }, { _id: 2 }, { _id: 1 }, { _id: 3 });
    const stop = fakeMongo();
    const stopped = await importCollection(stop.session, NS, bytesSource(file), {
      format: 'jsonl',
      batchSize: 2,
    });
    expect(stopped).toMatchObject({ read: 4, written: 2, skipped: 1, stopped: true });
    expect(stopped.errors).toEqual([{ row: 3, message: expect.stringContaining('duplicate key') }]);
    expect(stop.documents().map((d) => Number(d['_id']))).toEqual([1, 2]);

    const skip = fakeMongo();
    const skipped = await importCollection(skip.session, NS, bytesSource(file), {
      format: 'jsonl',
      batchSize: 10,
      onError: 'skip',
    });
    expect(skipped).toMatchObject({ read: 4, written: 3, skipped: 1, stopped: false });
    expect(skip.documents().map((d) => Number(d['_id']))).toEqual([1, 2, 3]);
  });

  it('upserts by _id, and replaces the whole collection after deleting it', async () => {
    const upsert = fakeMongo([
      { _id: 1, v: 'old' },
      { _id: 9, v: 'kept' },
    ]);
    const result = await importCollection(
      upsert.session,
      NS,
      bytesSource(lines({ _id: 1, v: 'new' }, { _id: 2, v: 'added' })),
      { format: 'jsonl', mode: 'upsert' },
    );
    expect(result).toMatchObject({ read: 2, written: 2, skipped: 0 });
    expect(upsert.documents()).toEqual([
      { _id: new Int32(1), v: 'new' },
      { _id: new Int32(9), v: 'kept' },
      { _id: new Int32(2), v: 'added' },
    ]);

    const replace = fakeMongo([{ _id: 1 }, { _id: 2 }]);
    const replaced = await importCollection(replace.session, NS, bytesSource(lines({ _id: 5 })), {
      format: 'jsonl',
      mode: 'replace',
    });
    expect(replaced).toMatchObject({ written: 1, deleted: 2 });
    expect(replace.documents().map((d) => d['_id'])).toEqual([new Int32(5)]);
  });

  it('skips lines that are not documents when asked, and counts them', async () => {
    const target = fakeMongo();
    const result = await importCollection(
      target.session,
      NS,
      bytesSource('{"a":1}\nnope\n{"a":2}\n'),
      { format: 'jsonl', onError: 'skip' },
    );
    expect(result).toMatchObject({ read: 3, written: 2, skipped: 1 });
    expect(result.errors[0]).toMatchObject({ row: 2, line: 2 });
  });

  it('reads BSON split anywhere, and refuses a file that is not BSON', async () => {
    const bytes = await exported('bson', [ORDER, { _id: new Int32(2) }]);
    async function* tiny() {
      for (let i = 0; i < bytes.length; i += 3) yield bytes.slice(i, i + 3);
    }
    const target = fakeMongo();
    await importCollection(
      target.session,
      NS,
      { [Symbol.asyncIterator]: tiny },
      { format: 'bson' },
    );
    expect(target.documents().map((d) => toEjson(d))).toEqual([
      toEjson(ORDER),
      toEjson({ _id: new Int32(2) }),
    ]);
    await expect(
      collect(readDocuments(bytesSource(bytes.slice(0, bytes.length - 2)), { format: 'bson' })),
    ).rejects.toThrow('The BSON file ends inside a document');
    await expect(
      collect(readDocuments(bytesSource('hello world'), { format: 'bson' })),
    ).rejects.toThrow('This is not a BSON file');
    expect(isBsonDocument(target.documents()[0])).toBe(true);
  });
});
