import { describe, expect, it } from 'vitest';

import {
  Decimal128,
  Double,
  Int32,
  Long,
  ObjectId,
  UUID,
  bsonTypeOf,
  parseValueEdit,
  toEjson,
  valueEditText,
  valueEditType,
} from '../src';

/** Editing one value in place (ADR 0036): shown as plain text in its type, read back in it. */

describe('valueEditType', () => {
  it('keeps the types with a plain form and edits the rest as mongosh text', () => {
    expect(valueEditType('int')).toBe('int');
    expect(valueEditType('date')).toBe('date');
    expect(valueEditType('object')).toBe('expression');
    expect(valueEditType('binData')).toBe('expression');
    expect(valueEditType('missing')).toBe('string');
  });
});

describe('valueEditText', () => {
  it('shows each value as plain text in its own type', () => {
    expect(valueEditText('Paris')).toBe('Paris');
    expect(valueEditText(new Int32(42))).toBe('42');
    expect(valueEditText(new Double(1.5))).toBe('1.5');
    expect(valueEditText(Long.fromString('9007199254740993'))).toBe('9007199254740993');
    expect(valueEditText(Decimal128.fromString('1.50'))).toBe('1.50');
    expect(valueEditText(true)).toBe('true');
    expect(valueEditText(null)).toBe('');
    expect(valueEditText(new Date('2026-01-02T00:00:00Z'))).toBe('2026-01-02T00:00:00.000Z');
    expect(valueEditText(new ObjectId('65a1b2c3d4e5f60718293a4b'))).toBe(
      '65a1b2c3d4e5f60718293a4b',
    );
    expect(valueEditText(new UUID('3b241101-e2bb-4255-8caf-4136c566a962').toBinary())).toBe(
      '3b241101-e2bb-4255-8caf-4136c566a962',
    );
  });

  it('shows containers and other types as mongosh text, and keeps the text on a type change', () => {
    expect(valueEditText({ city: 'Paris' })).toBe("{ city: 'Paris' }");
    expect(valueEditText([1, 2])).toBe('[ 1, 2 ]');
    expect(valueEditText(new Int32(42), 'string')).toBe('42');
    expect(valueEditText({ a: 1 }, 'string')).toBe('');
    expect(valueEditText('x', 'expression')).toBe("'x'");
  });
});

describe('parseValueEdit', () => {
  it('reads text back in the chosen type', () => {
    expect(toEjson(parseValueEdit('42', 'int'))).toBe('{"$numberInt":"42"}');
    expect(toEjson(parseValueEdit('9007199254740993', 'long'))).toBe(
      '{"$numberLong":"9007199254740993"}',
    );
    expect(toEjson(parseValueEdit('2', 'double'))).toBe('{"$numberDouble":"2.0"}');
    expect(toEjson(parseValueEdit('1.50', 'decimal'))).toBe('{"$numberDecimal":"1.50"}');
    expect(parseValueEdit('TRUE', 'bool')).toBe(true);
    expect(parseValueEdit(' 42 ', 'string')).toBe(' 42 ');
    expect(parseValueEdit('anything', 'null')).toBeNull();
    expect((parseValueEdit('2026-01-31', 'date') as Date).toISOString()).toBe(
      '2026-01-31T00:00:00.000Z',
    );
    expect(bsonTypeOf(parseValueEdit('65A1B2C3D4E5F60718293A4B', 'objectId'))).toBe('objectId');
    expect(bsonTypeOf(parseValueEdit('3b241101-e2bb-4255-8caf-4136c566a962', 'uuid'))).toBe('uuid');
    expect(parseValueEdit("{ city: 'Lyon', n: NumberLong(5) }", 'expression')).toEqual({
      city: 'Lyon',
      n: Long.fromNumber(5),
    });
  });

  it('round-trips what it shows', () => {
    for (const value of [
      new Int32(-7),
      Long.fromString('-9223372036854775808'),
      new Double(0.1),
      Decimal128.fromString('12345678901234567890.123'),
      new Date('1969-07-20T20:17:40Z'),
      new ObjectId(),
    ]) {
      const type = valueEditType(bsonTypeOf(value));
      expect(toEjson(parseValueEdit(valueEditText(value), type))).toBe(toEjson(value));
    }
  });

  it('says why text does not fit the type', () => {
    expect(() => parseValueEdit('4.2', 'int')).toThrow('"4.2" is not a whole number');
    expect(() => parseValueEdit('3000000000', 'int')).toThrow('does not fit in an Int32');
    expect(() => parseValueEdit('9223372036854775808', 'long')).toThrow('does not fit in an Int64');
    expect(() => parseValueEdit('ten', 'double')).toThrow('"ten" is not a number');
    expect(() => parseValueEdit('yes', 'bool')).toThrow('is not true or false');
    expect(() => parseValueEdit('31/01/2026', 'date')).toThrow('is not a date');
    expect(() => parseValueEdit('abc', 'objectId')).toThrow('24 hexadecimal digits');
    expect(() => parseValueEdit('{ a: ', 'expression')).toThrow();
  });
});
