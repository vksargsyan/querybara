import type { UUID } from 'bson';
import { Decimal128, Double, Int32, Long, ObjectId } from 'bson';
import { describe, expect, it } from 'vitest';

import {
  analyzeSchema,
  defaultGeneratorRules,
  generateDocuments,
  toEjson,
  type BsonDocument,
  type GeneratorRule,
} from '../src';

/** The Data Generator: documents made up from a rule per field, the same for the same seed. */

const NOW = new Date('2026-10-28T12:00:00.000Z');

describe('generateDocuments', () => {
  const rules: GeneratorRule[] = [
    { field: '_id', kind: 'objectId' },
    { field: 'n', kind: 'sequence', min: 100, max: 5 },
    { field: 'name', kind: 'fullName' },
    { field: 'email', kind: 'email' },
    { field: 'address.city', kind: 'city' },
    { field: 'address.street', kind: 'street' },
    { field: 'age', kind: 'int', min: 18, max: 30 },
    { field: 'score', kind: 'double', min: 0, max: 1, decimals: 3 },
    { field: 'price', kind: 'decimal', min: 1, max: 9 },
    { field: 'views', kind: 'long', min: 0, max: 10 },
    { field: 'active', kind: 'bool', trueShare: 100 },
    { field: 'joined', kind: 'date', from: '2020-01-01', to: '2020-12-31' },
    { field: 'status', kind: 'pick', values: "['A', 'B', NumberInt(3)]" },
    { field: 'source', kind: 'constant', values: "{ app: 'qb' }" },
    { field: 'tags', kind: 'words', min: 1, max: 1, arrayMin: 2, arrayMax: 2 },
    { field: 'key', kind: 'uuid' },
    { field: 'nothing', kind: 'null' },
  ];

  it('makes each kind of value, nested where the path says', () => {
    const docs = generateDocuments(rules, { count: 20, seed: 7, now: NOW });
    expect(docs).toHaveLength(20);
    docs.forEach((doc, i) => {
      expect(doc['_id']).toBeInstanceOf(ObjectId);
      expect(doc['n']).toEqual(new Int32(100 + i * 5));
      expect(doc['name']).toMatch(/^\p{L}+ \p{L}+$/u);
      expect(doc['email']).toMatch(/^[a-z]+\.[a-z]+\d+@example\.(com|net|org)$/);
      const address = doc['address'] as BsonDocument;
      expect(typeof address['city']).toBe('string');
      expect(address['street']).toMatch(/^\d+ \w+ \w+$/);
      const age = (doc['age'] as Int32).value;
      expect(age).toBeGreaterThanOrEqual(18);
      expect(age).toBeLessThanOrEqual(30);
      expect(doc['score']).toBeInstanceOf(Double);
      expect(String((doc['score'] as Double).value)).toMatch(/^\d(\.\d{1,3})?$/);
      expect(doc['price']).toBeInstanceOf(Decimal128);
      expect(doc['views']).toBeInstanceOf(Long);
      expect(doc['active']).toBe(true);
      const joined = (doc['joined'] as Date).getTime();
      expect(joined).toBeGreaterThanOrEqual(Date.parse('2020-01-01'));
      expect(joined).toBeLessThanOrEqual(Date.parse('2020-12-31'));
      expect(['A', 'B', 3]).toContainEqual(
        doc['status'] instanceof Int32 ? doc['status'].value : doc['status'],
      );
      expect(doc['source']).toEqual({ app: 'qb' });
      expect(doc['tags']).toHaveLength(2);
      expect((doc['key'] as UUID).toHexString()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(doc['nothing']).toBeNull();
    });
  });

  it('gives the same documents for the same seed, batch by batch', () => {
    const whole = generateDocuments(rules, { count: 10, seed: 42, now: NOW });
    const second = generateDocuments(rules, { count: 5, seed: 42, start: 5, now: NOW });
    expect(toEjson(second)).toBe(toEjson(whole.slice(5)));
    expect(toEjson(generateDocuments(rules, { count: 10, seed: 43, now: NOW }))).not.toBe(
      toEjson(whole),
    );
  });

  it('leaves a field out of its share of documents', () => {
    const docs = generateDocuments([{ field: 'x', kind: 'int', missing: 30 }], {
      count: 2000,
      seed: 1,
    });
    const without = docs.filter((doc) => !('x' in doc)).length / docs.length;
    expect(without).toBeGreaterThan(0.25);
    expect(without).toBeLessThan(0.35);
  });

  it('refuses rules that cannot work, naming the field', () => {
    const fails =
      (rule: GeneratorRule, others: GeneratorRule[] = []) =>
      () =>
        generateDocuments([rule, ...others], { count: 1 });
    expect(fails({ field: 'a', kind: 'int', min: 5, max: 1 })).toThrow(/a: the range starts/);
    expect(fails({ field: 'a', kind: 'pick', values: '42' })).toThrow(/a: list the values/);
    expect(fails({ field: 'a', kind: 'constant', values: '{' })).toThrow(/a: the value does not/);
    expect(fails({ field: '$a', kind: 'int' })).toThrow(/not a field path/);
    expect(fails({ field: 'a', kind: 'int' }, [{ field: 'a.b', kind: 'int' }])).toThrow(
      /a: a\.b is made inside it/,
    );
    expect(fails({ field: 'a', kind: 'int' }, [{ field: 'a', kind: 'city' }])).toThrow(
      /two rules make this field/,
    );
  });
});

describe('defaultGeneratorRules', () => {
  it('guesses a rule per field from its name, type and values', () => {
    const sample: BsonDocument[] = Array.from({ length: 40 }, (_, i) => ({
      _id: new ObjectId(),
      email: `p${i}@example.com`,
      firstName: 'Ada',
      status: ['new', 'done'][i % 2]!,
      qty: new Int32(i + 1),
      when: new Date(Date.UTC(2024, 0, 1 + i)),
      address: { city: 'Paris', zip: '75001' },
      tags: ['a', 'b'],
      ...(i % 4 === 0 ? { note: 'sometimes' } : {}),
    }));
    const rules = defaultGeneratorRules(analyzeSchema(sample));
    const byField = Object.fromEntries(rules.map((rule) => [rule.field, rule]));
    expect(byField['_id']).toEqual({ field: '_id', kind: 'objectId' });
    expect(byField['email']?.kind).toBe('email');
    expect(byField['firstName']?.kind).toBe('firstName');
    expect(byField['status']).toEqual({ field: 'status', kind: 'pick', values: "['new', 'done']" });
    // The range of the values the sample counted.
    const qty = byField['qty']!;
    expect(qty.kind).toBe('int');
    expect(qty.min).toBeGreaterThanOrEqual(1);
    expect(qty.max).toBeLessThanOrEqual(40);
    expect(qty.min).toBeLessThan(qty.max!);
    expect(byField['when']?.kind).toBe('date');
    expect(byField['address.city']?.kind).toBe('city');
    expect(byField['address.zip']?.kind).toBe('zip');
    expect(byField['address']).toBeUndefined();
    expect(byField['tags']).toMatchObject({ arrayMin: 2, arrayMax: 2 });
    expect(byField['note']?.missing).toBe(75);
    // The rules work as they are.
    expect(generateDocuments(rules, { count: 3, seed: 1 })).toHaveLength(3);
  });
});
