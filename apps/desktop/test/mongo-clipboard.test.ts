import { Int32, ObjectId, toEjson } from '@querybara/mongo-tools';
import { describe, expect, it } from 'vitest';

import { documentsText, pastedDocuments } from '../src/renderer/src/state/mongo/clipboard';

/** Copy and Paste of MongoDB documents (ADR 0036): the paste editor's text and what it inserts. */

describe('the paste editor', () => {
  it('shows one copied document alone and several as an array', () => {
    const one = toEjson({ _id: new Int32(1), name: 'Ada' });
    expect(documentsText([one])).toBe("{ _id: 1, name: 'Ada' }");
    expect(documentsText([one, toEjson({ _id: new Int32(2) })])).toBe(
      "[ { _id: 1, name: 'Ada' }, { _id: 2 } ]",
    );
  });

  it('reads mongosh or Extended JSON, one document or an array, keeping types', () => {
    expect(pastedDocuments("{ _id: ObjectId('65a1b2c3d4e5f60718293a4b'), n: 1 }", false)).toEqual([
      { _id: new ObjectId('65a1b2c3d4e5f60718293a4b'), n: new Int32(1) },
    ]);
    expect(
      pastedDocuments('[{"_id": {"$oid": "65a1b2c3d4e5f60718293a4b"}}, {"a": 2}]', false),
    ).toEqual([{ _id: new ObjectId('65a1b2c3d4e5f60718293a4b') }, { a: new Int32(2) }]);
  });

  it('drops each _id for a new one when asked, and refuses what is not a document', () => {
    expect(pastedDocuments('[{ _id: 1, a: 1 }, { b: 2 }]', true)).toEqual([
      { a: new Int32(1) },
      { b: new Int32(2) },
    ]);
    expect(() => pastedDocuments('[]', false)).toThrow('There are no documents to paste');
    expect(() => pastedDocuments('[{ a: 1 }, 5]', false)).toThrow('Item 2 is not a document');
    expect(() => pastedDocuments('{ a: ', false)).toThrow();
  });
});
