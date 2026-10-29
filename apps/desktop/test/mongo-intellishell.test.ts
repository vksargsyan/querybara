import { toEjson } from '@querybara/mongo-tools';
import { describe, expect, it } from 'vitest';

import {
  documentsText,
  errorText,
  inputText,
  runScope,
} from '../src/renderer/src/state/mongo/intellishell';
import {
  completionContext,
  completionInsert,
  fieldKey,
} from '../src/renderer/src/state/mongo/shell-completion';

/** IntelliShell's run scopes, raw output text and autocompletion context (ADR 0036). */

describe('runScope', () => {
  const text = 'db.a.find()\n\ndb.b.find()\n  .limit(2)\n';

  it('runs everything, the statement at the cursor or the selection', () => {
    expect(runScope(text, 'all', { cursor: 0 })).toEqual({ script: text, base: 0 });
    expect(runScope(text, 'statement', { cursor: text.indexOf('limit') })).toEqual({
      script: 'db.b.find()\n  .limit(2)',
      base: text.indexOf('db.b'),
    });
    expect(runScope(text, 'selection', { cursor: 0, selection: { start: 0, end: 4 } })).toEqual({
      script: 'db.a',
      base: 0,
    });
  });

  it('falls back to the statement without a selection, and to everything when it does not parse', () => {
    expect(runScope(text, 'selection', { cursor: 1 }).script).toBe('db.a.find()');
    const broken = 'db.a.find(\nprint(1)';
    expect(runScope(broken, 'statement', { cursor: 0 })).toEqual({ script: broken, base: 0 });
  });
});

describe('raw shell output', () => {
  it('prints errors as mongosh does', () => {
    expect(
      errorText({
        type: 'error',
        name: 'MongoServerError',
        codeName: 'Unauthorized',
        message: 'not allowed',
      }),
    ).toBe('MongoServerError[Unauthorized]: not allowed');
    expect(errorText({ type: 'error', name: 'Error', message: 'boom' })).toBe('boom');
    expect(errorText({ type: 'error', name: 'TypeError', message: 'TypeError: x' })).toBe(
      'TypeError: x',
    );
  });

  it('prints documents in shell syntax and statements by their first line', () => {
    expect(documentsText([toEjson({ _id: 1, at: new Date(0) })])).toBe(
      "{ _id: 1, at: ISODate('1970-01-01T00:00:00.000Z') }",
    );
    expect(inputText('  db.a.find()\n  .limit(1)')).toBe('db.a.find() …');
    expect(inputText('show dbs')).toBe('show dbs');
  });
});

describe('completionContext', () => {
  it('hands mongosh the statement up to the cursor, chained lines joined', () => {
    expect(completionContext('db.ord')).toEqual({ line: 'db.ord', word: 'ord' });
    expect(completionContext('const n = 1; db.orders.fi')).toMatchObject({
      line: 'db.orders.fi',
      word: 'fi',
    });
    expect(completionContext('db.orders.find()\n  .so')).toMatchObject({
      line: 'db.orders.find().so',
      word: 'so',
    });
  });

  it('knows the collection a query document is about', () => {
    expect(completionContext('db.orders.find({ cus').fieldsOf).toEqual({
      db: undefined,
      collection: 'orders',
    });
    expect(
      completionContext(
        'db.getSiblingDB("shop").getCollection("line items").aggregate([{ $match: { q',
      ).fieldsOf,
    ).toEqual({ db: 'shop', collection: 'line items' });
    expect(completionContext('db.orders.find({}).sort({ to').fieldsOf?.collection).toBe('orders');
    // Outside the braces, or in a string, fields do not apply.
    expect(completionContext('db.orders.find({ a: 1 }).').fieldsOf).toBeUndefined();
    expect(completionContext('db.orders.find({ a: "cu').fieldsOf).toBeUndefined();
  });

  it('turns mongosh candidates into what replaces the word, and quotes dotted fields', () => {
    const context = completionContext('db.orders.fi');
    expect(completionInsert(context, 'db.orders.find')).toBe('find');
    expect(completionInsert(context, 'db.other.find')).toBeUndefined();
    expect(completionInsert(context, 'db.orders.fi')).toBeUndefined();
    expect(fieldKey('customer')).toBe('customer');
    expect(fieldKey('customer.name')).toBe('"customer.name"');
  });
});
