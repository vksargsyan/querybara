import {
  Decimal128,
  Double,
  Int32,
  Long,
  fromEjson,
  outputStage,
  reshapeStages,
  toEjson,
  type BsonDocument,
  type ReshapeRule,
} from '@querybara/mongo-tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { MongoSession } from '../../src';
import { MONGO_URL, connectMongo, drain, testDatabase } from './helpers';

/**
 * Reschema and Data Masking pipelines (ADR 0038) run by the server: fields moved, converted,
 * left out and masked, numbers and dates moved within their spread, written with $out and
 * $merge into another collection.
 */

const PEOPLE: BsonDocument[] = Array.from({ length: 50 }, (_, i) => ({
  _id: new Int32(i + 1),
  name: `Person number ${i + 1}`,
  email: `person${i + 1}@example.com`,
  age: new Int32(20 + i),
  salary: Decimal128.fromString(`${1000 + i}.50`),
  score: 10.5 + i,
  visits: Long.fromNumber(100 + i),
  born: new Date(Date.UTC(1990, 0, 1 + i)),
  zip: String(10000 + i),
  address: { city: 'Paris', street: `${i} Rue de Rivoli` },
}));

describe.skipIf(!MONGO_URL)('reshape pipelines', () => {
  const db = testDatabase();
  let session: MongoSession;
  const ns = { db, collection: 'people' };

  beforeAll(async () => {
    session = await connectMongo(MONGO_URL!);
    await session.insertMany(ns, toEjson(PEOPLE));
  });

  afterAll(async () => {
    await session?.dropDatabase(db).catch(() => undefined);
    await session?.close();
  });

  async function run(rules: ReshapeRule[], onlyListed = false): Promise<BsonDocument[]> {
    const pipeline = [{ $sort: { _id: 1 } }, ...reshapeStages(rules, { onlyListed })];
    const docs = await drain(session.aggregate(ns, toEjson(pipeline)));
    return docs.map((text) => fromEjson(text) as BsonDocument);
  }

  it('moves, nests, converts and leaves out fields', async () => {
    const [first] = await run([
      { field: 'name', action: 'keep', target: 'profile.name' },
      { field: 'zip', action: 'convert', type: 'int', target: 'address.zip' },
      { field: 'age', action: 'convert', type: 'string' },
      { field: 'email', action: 'exclude' },
      { field: '', action: 'computed', target: 'adult', value: "{ $gte: ['$age', 18] }" },
    ]);
    expect(first).toEqual({
      _id: new Int32(1),
      age: '20',
      salary: Decimal128.fromString('1000.50'),
      score: new Double(10.5),
      visits: Long.fromNumber(100),
      born: new Date(Date.UTC(1990, 0, 1)),
      address: { city: 'Paris', street: '0 Rue de Rivoli', zip: new Int32(10000) },
      profile: { name: 'Person number 1' },
      adult: true,
    });
  });

  it('keeps only the listed fields when asked', async () => {
    const [first] = await run(
      [
        { field: 'name', action: 'keep' },
        { field: 'address.city', action: 'keep', target: 'city' },
      ],
      true,
    );
    expect(first).toEqual({ _id: new Int32(1), name: 'Person number 1', city: 'Paris' });
  });

  it('masks text, fixes and nulls values, and moves numbers and dates within their spread', async () => {
    const docs = await run([
      { field: 'email', action: 'mask', keepStart: 2, keepEnd: 4 },
      { field: 'zip', action: 'mask', keepStart: 3, keepEnd: 3, maskChar: '#' },
      { field: 'name', action: 'fixed', value: "'Redacted'" },
      { field: 'address.street', action: 'null' },
      { field: 'age', action: 'random-number', spread: 10 },
      { field: 'salary', action: 'random-number', spread: 50 },
      { field: 'visits', action: 'random-number', spread: 0 },
      { field: 'born', action: 'random-date', spread: 30 },
    ]);
    const first = docs[0]!;
    expect(first['email']).toBe('pe*************.com');
    // Five characters, all of them shown: masked whole.
    expect(first['zip']).toBe('#####');
    expect(first['name']).toBe('Redacted');
    expect(first['address']).toEqual({ city: 'Paris', street: null });
    for (const [i, doc] of docs.entries()) {
      const age = doc['age'] as Int32;
      expect(age).toBeInstanceOf(Int32);
      expect(Math.abs(age.value - (20 + i))).toBeLessThanOrEqual(Math.ceil((20 + i) * 0.1));
      expect(doc['salary']).toBeInstanceOf(Decimal128);
      expect(doc['visits']).toEqual(Long.fromNumber(100 + i));
      const born = (doc['born'] as Date).getTime();
      expect(Math.abs(born - Date.UTC(1990, 0, 1 + i))).toBeLessThanOrEqual(30 * 86_400_000);
    }
  });

  it('writes into another collection with $out, and merges with $merge', async () => {
    const rules: ReshapeRule[] = [{ field: 'email', action: 'exclude' }];
    const write = async (mode: 'replace' | 'merge', match: BsonDocument = {}) => {
      const pipeline = [{ $match: match }, ...reshapeStages(rules), outputStage('people_v2', mode)];
      await drain(session.aggregate(ns, toEjson(pipeline)));
    };
    await write('replace', { _id: { $lte: 10 } });
    expect(await session.count({ db, collection: 'people_v2' })).toBe(10);
    await write('merge');
    expect(await session.count({ db, collection: 'people_v2' })).toBe(50);
    const docs = await drain(session.find({ db, collection: 'people_v2' }, { limit: 1 }));
    expect(fromEjson(docs[0]!)).not.toHaveProperty('email');
  });
});
