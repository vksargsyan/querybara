import { QuerybaraError } from '@querybara/core';

import {
  Binary,
  Decimal128,
  Double,
  Int32,
  Long,
  ObjectId,
  UUID,
  bsonTypeOf,
  type BsonTypeName,
  type BsonValue,
} from './bson';
import { formatShell } from './shell/format';
import { parseIsoDate, parseShell } from './shell/parser';

/**
 * Editing one value in place (ADR 0036), as Studio 3T's Table and Tree views do: the value shows
 * as plain text in its type (a string without quotes, a date as ISO text, an ObjectId as its hex)
 * and is read back in the type chosen beside it, so typing 42 into an Int32 field keeps an
 * Int32. Values with no plain form (documents, arrays, binary, regular expressions...) and any
 * value whose type is set to `expression` are edited as mongosh text.
 */

/** The types a value can be typed as in place; `expression` is any value as mongosh text. */
export const VALUE_EDIT_TYPES = [
  'string',
  'int',
  'long',
  'double',
  'decimal',
  'bool',
  'date',
  'objectId',
  'uuid',
  'null',
  'expression',
] as const;
export type ValueEditType = (typeof VALUE_EDIT_TYPES)[number];

export const VALUE_EDIT_LABELS: Readonly<Record<ValueEditType, string>> = {
  string: 'String',
  int: 'Int32',
  long: 'Int64',
  double: 'Double',
  decimal: 'Decimal128',
  bool: 'Boolean',
  date: 'Date',
  objectId: 'ObjectId',
  uuid: 'UUID',
  null: 'Null',
  expression: 'mongosh expression',
};

/** The type a value is edited as: its own when it has a plain form, else `expression`. */
export function valueEditType(type: BsonTypeName | 'missing'): ValueEditType {
  if (type === 'missing') return 'string';
  return (VALUE_EDIT_TYPES as readonly string[]).includes(type)
    ? (type as ValueEditType)
    : 'expression';
}

/** A value's text in its own type, where it has a plain form. */
function plainText(value: BsonValue): string | undefined {
  switch (bsonTypeOf(value)) {
    case 'string':
      return value as string;
    case 'null':
      return '';
    case 'bool':
      return String(value);
    case 'date':
      return (value as Date).toISOString();
    case 'objectId':
      return (value as ObjectId).toHexString();
    case 'uuid': {
      const hex = (value as Binary).toString('hex');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    case 'int':
    case 'double':
      return String(typeof value === 'number' ? value : (value as Int32 | Double).value);
    case 'long':
      return typeof value === 'number' ? String(value) : (value as Long).toString();
    case 'decimal':
      return (value as Decimal128).toString();
    default:
      return undefined;
  }
}

/**
 * The text a value is edited as, in `type` (its own edit type by default). Changing the type
 * keeps what the value reads as (42 stays "42" as a String); a document or an array typed as
 * anything but an expression starts empty.
 */
export function valueEditText(
  value: BsonValue | undefined,
  type: ValueEditType = valueEditType(value === undefined ? 'missing' : bsonTypeOf(value)),
): string {
  if (value === undefined) return '';
  if (type === 'expression') return formatShell(value);
  return plainText(value) ?? '';
}

function invalid(message: string, hint?: string): QuerybaraError {
  return new QuerybaraError({
    code: 'VALIDATION_FAILED',
    message,
    ...(hint !== undefined ? { hint } : {}),
  });
}

const INTEGER = /^[+-]?\d+$/;
const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/** Reads `text` back as a value of `type`; fails with VALIDATION_FAILED saying why. */
export function parseValueEdit(text: string, type: ValueEditType): BsonValue {
  const trimmed = text.trim();
  switch (type) {
    case 'string':
      return text;
    case 'null':
      return null;
    case 'int': {
      if (!INTEGER.test(trimmed)) throw invalid(`"${trimmed}" is not a whole number`);
      const n = Number(trimmed);
      if (n < -2147483648 || n > 2147483647) {
        throw invalid(`${trimmed} does not fit in an Int32`, 'Choose Int64 for larger numbers');
      }
      return new Int32(n);
    }
    case 'long': {
      if (!INTEGER.test(trimmed)) throw invalid(`"${trimmed}" is not a whole number`);
      const n = BigInt(trimmed);
      if (n < -(2n ** 63n) || n > 2n ** 63n - 1n) {
        throw invalid(
          `${trimmed} does not fit in an Int64`,
          'Choose Decimal128 for larger numbers',
        );
      }
      return Long.fromBigInt(n);
    }
    case 'double': {
      if (!NUMBER.test(trimmed) && !/^[+-]?(Infinity|NaN)$/.test(trimmed)) {
        throw invalid(`"${trimmed}" is not a number`);
      }
      return new Double(Number(trimmed));
    }
    case 'decimal': {
      if (!NUMBER.test(trimmed) && !/^[+-]?(Infinity|NaN)$/i.test(trimmed)) {
        throw invalid(`"${trimmed}" is not a decimal number`);
      }
      try {
        return Decimal128.fromString(trimmed);
      } catch (error) {
        throw invalid(error instanceof Error ? error.message : `"${trimmed}" is not a decimal`);
      }
    }
    case 'bool':
      if (/^true$/i.test(trimmed)) return true;
      if (/^false$/i.test(trimmed)) return false;
      throw invalid(`"${trimmed}" is not true or false`);
    case 'date': {
      const date = parseIsoDate(trimmed);
      if (!date) {
        throw invalid(
          `"${trimmed}" is not a date`,
          'Write it as ISO 8601, e.g. 2026-01-31 or 2026-01-31T12:00:00Z',
        );
      }
      return date;
    }
    case 'objectId':
      if (!/^[0-9a-f]{24}$/i.test(trimmed)) throw invalid('An ObjectId is 24 hexadecimal digits');
      return ObjectId.createFromHexString(trimmed.toLowerCase());
    case 'uuid':
      try {
        return new UUID(trimmed).toBinary();
      } catch {
        throw invalid(`"${trimmed}" is not a UUID`);
      }
    case 'expression':
      return parseShell(text);
  }
}
