import type { Binary, BsonValue, Long, Timestamp } from '@querybara/mongo-tools';
import { bsonTag, bsonTypeOf, isBsonDocument, toEjson } from '@querybara/mongo-tools';

import { canonicalDecimal, compareCodePoints, compareDecimals } from '../data/canonical';

/**
 * BSON values for MongoDB compare: a canonical text form for equality and MongoDB's comparison
 * order for merging `_id`-sorted streams. Values are what `fromEjson` returns (numbers keep
 * their BSON type as Int32, Double and Long instances).
 */

/** How strictly two values must match. */
export interface BsonCanonicalOptions {
  /** Documents with the same fields in another order are equal (default true). */
  readonly ignoreFieldOrder?: boolean;
  /** Int32 1, Long 1, Double 1.0 and Decimal128 1 are equal, as MongoDB queries treat them. */
  readonly ignoreNumericTypes?: boolean;
}

const NUMERIC_TYPES = new Set(['int', 'long', 'double', 'decimal']);

/** Decimal text of a numeric BSON value; NaN and infinities spelled out. */
function numericText(value: BsonValue): string {
  const type = bsonTypeOf(value);
  if (type === 'long') return (value as Long).toString();
  const text =
    type === 'decimal'
      ? String(value)
      : String(typeof value === 'number' ? value : (value as { value: number }).value);
  if (/^-?(nan|infinity|inf)$/i.test(text)) {
    return /nan/i.test(text) ? 'NaN' : text.startsWith('-') ? '-Infinity' : 'Infinity';
  }
  return canonicalDecimal(text) ?? text;
}

/**
 * A text form in which two values are equal exactly when they hold the same data under the
 * options: field order and numeric types as configured, everything else as stored (strings
 * by code point, dates to the millisecond, binary with its subtype).
 */
export function canonicalBson(value: BsonValue, options: BsonCanonicalOptions = {}): string {
  const ignoreOrder = options.ignoreFieldOrder ?? true;
  const ignoreNumbers = options.ignoreNumericTypes ?? false;
  const walk = (v: BsonValue): string => {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'string') return JSON.stringify(v);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (Array.isArray(v)) return `[${v.map(walk).join(',')}]`;
    if (isBsonDocument(v)) {
      const keys = Object.keys(v);
      if (ignoreOrder) keys.sort(compareCodePoints);
      return `{${keys.map((k) => `${JSON.stringify(k)}:${walk(v[k]!)}`).join(',')}}`;
    }
    const type = bsonTypeOf(v);
    if (NUMERIC_TYPES.has(type)) {
      return ignoreNumbers ? `n:${numericText(v)}` : `${type}:${numericText(v)}`;
    }
    return toEjson(v);
  };
  return walk(value);
}

// ---------------------------------------------------------------------------------------------
// Comparison order

/**
 * MongoDB's order of BSON types (https://www.mongodb.com/docs/manual/reference/bson-type-comparison-order/):
 * MinKey, null, numbers, symbols and strings, objects, arrays, binary data, ObjectId, booleans,
 * dates, timestamps, regular expressions, MaxKey.
 */
function typeRank(value: BsonValue): number {
  switch (bsonTypeOf(value)) {
    case 'minKey':
      return 1;
    case 'null':
    case 'undefined':
      return 2;
    case 'int':
    case 'long':
    case 'double':
    case 'decimal':
      return 3;
    case 'symbol':
    case 'string':
      return 4;
    case 'object':
      return 5;
    case 'array':
      return 6;
    case 'binData':
    case 'uuid':
      return 7;
    case 'objectId':
      return 8;
    case 'bool':
      return 9;
    case 'date':
      return 10;
    case 'timestamp':
      return 11;
    case 'regex':
      return 12;
    case 'javascript':
      return 13;
    case 'maxKey':
      return 14;
    default:
      return 15;
  }
}

const sign = (n: number): number => (n < 0 ? -1 : n > 0 ? 1 : 0);

function compareNumbers(a: BsonValue, b: BsonValue): number {
  const x = numericText(a);
  const y = numericText(b);
  // NaN sorts before every other number; infinities at the ends.
  const rank = (t: string): number =>
    t === 'NaN' ? 0 : t === '-Infinity' ? 1 : t === 'Infinity' ? 3 : 2;
  const rx = rank(x);
  const ry = rank(y);
  if (rx !== ry || rx !== 2) return sign(rx - ry);
  return sign(compareDecimals(x, y));
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return sign(a.length - b.length);
}

function compareEntries(a: [string, BsonValue][], b: [string, BsonValue][]): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    const [ka, va] = a[i]!;
    const [kb, vb] = b[i]!;
    const byType = sign(typeRank(va) - typeRank(vb));
    if (byType !== 0) return byType;
    const byName = compareCodePoints(ka, kb);
    if (byName !== 0) return sign(byName);
    const byValue = compareBson(va, vb);
    if (byValue !== 0) return byValue;
  }
  return sign(a.length - b.length);
}

/**
 * Orders two values the way MongoDB sorts them with the simple (binary) collation: by type
 * rank, then numbers numerically across Int32/Long/Double/Decimal128, strings by code point,
 * documents and arrays element by element, binary by length, subtype and bytes, and so on.
 */
export function compareBson(a: BsonValue, b: BsonValue): number {
  const byType = sign(typeRank(a) - typeRank(b));
  if (byType !== 0) return byType;
  const type = bsonTypeOf(a);
  switch (typeRank(a)) {
    case 3:
      return compareNumbers(a, b);
    case 4:
      return sign(compareCodePoints(String(a), String(b)));
    case 5:
      return compareEntries(
        Object.entries(a as Record<string, BsonValue>),
        Object.entries(b as Record<string, BsonValue>),
      );
    case 6:
      return compareEntries(
        (a as BsonValue[]).map((v, i) => [String(i), v]),
        (b as BsonValue[]).map((v, i) => [String(i), v]),
      );
    case 7: {
      const x = a as Binary;
      const y = b as Binary;
      const lengths = sign(x.length() - y.length());
      if (lengths !== 0) return lengths;
      const subtypes = sign(x.sub_type - y.sub_type);
      return subtypes !== 0 ? subtypes : compareBytes(x.value(), y.value());
    }
    case 8:
      return sign(compareCodePoints(String(a), String(b)));
    case 9:
      return sign(Number(a) - Number(b));
    case 10:
      return sign((a as Date).getTime() - (b as Date).getTime());
    case 11: {
      const x = a as Timestamp;
      const y = b as Timestamp;
      return sign(x.t - y.t) || sign(x.i - y.i);
    }
    default:
      if (type === 'regex' || bsonTag(a) !== undefined) {
        const x = toEjson(a);
        const y = toEjson(b);
        return x < y ? -1 : x > y ? 1 : 0;
      }
      return 0;
  }
}
