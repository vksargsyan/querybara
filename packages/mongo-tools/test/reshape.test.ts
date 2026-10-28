import { describe, expect, it } from 'vitest';

import { outputStage, reshapeStages } from '../src';

/** Reschema and Data Masking rules compiled to a pipeline (ADR 0038); the server runs them. */

describe('reshapeStages', () => {
  it('sets what changes, unsets what is left out or moved away', () => {
    expect(
      reshapeStages([
        { field: 'name', action: 'keep' },
        { field: 'first', action: 'keep', target: 'person.first' },
        { field: 'zip', action: 'convert', type: 'int' },
        { field: 'ssn', action: 'exclude' },
      ]),
    ).toEqual([
      {
        $set: {
          'person.first': '$first',
          zip: { $convert: { input: '$zip', to: 'int', onError: '$zip', onNull: null } },
        },
      },
      { $unset: ['first', 'ssn'] },
    ]);
    expect(reshapeStages([{ field: 'a', action: 'keep' }])).toEqual([]);
  });

  it('projects only the listed fields when asked, _id too unless it is left out', () => {
    expect(
      reshapeStages(
        [
          { field: 'a', action: 'keep' },
          { field: 'b.c', action: 'keep', target: 'c' },
        ],
        { onlyListed: true },
      ),
    ).toEqual([{ $set: { c: '$b.c' } }, { $unset: ['b.c'] }, { $project: { a: 1, c: 1 } }]);
    expect(
      reshapeStages(
        [
          { field: '_id', action: 'exclude' },
          { field: 'a', action: 'keep' },
        ],
        { onlyListed: true },
      ),
    ).toEqual([{ $unset: ['_id'] }, { $project: { _id: 0, a: 1 } }]);
  });

  it('writes fixed values as literals and computed fields as expressions', () => {
    expect(
      reshapeStages([
        { field: 'pin', action: 'fixed', value: "'$secret'" },
        { field: 'note', action: 'null' },
        { field: '', action: 'computed', target: 'total', value: "{ $add: ['$a', '$b'] }" },
      ]),
    ).toEqual([
      {
        $set: {
          pin: { $literal: '$secret' },
          note: { $literal: null },
          total: { $add: ['$a', '$b'] },
        },
      },
    ]);
  });

  it('refuses rules that cannot work, naming the rule', () => {
    expect(() => reshapeStages([{ field: '$a', action: 'keep' }])).toThrow(
      'Rule 1: "$a" is not a field path',
    );
    expect(() => reshapeStages([{ field: 'a', action: 'convert' }])).toThrow(
      'Rule 1: choose the type to convert to',
    );
    expect(() =>
      reshapeStages([
        { field: 'a', action: 'keep', target: 'x' },
        { field: 'b', action: 'keep', target: 'x.y' },
      ]),
    ).toThrow('Rule 2: x.y and x would overwrite each other');
    expect(() => reshapeStages([{ field: 'a', action: 'keep', target: 'a.b' }])).toThrow(
      'Rule 1: a cannot move inside itself',
    );
    expect(() => reshapeStages([{ field: 'a', action: 'keep', target: '_id' }])).toThrow(
      'only the _id field writes _id',
    );
    expect(() => reshapeStages([{ field: '', action: 'computed', target: 't' }])).toThrow(
      'Rule 1: give the expression',
    );
    expect(() =>
      reshapeStages([{ field: '', action: 'computed', target: 't', value: '{ $add: [' }]),
    ).toThrow(/Rule 1: the expression does not parse/);
    expect(() => reshapeStages([{ field: 'a', action: 'mask', maskChar: '**' }])).toThrow(
      'the mask is one character',
    );
    expect(() =>
      reshapeStages([
        { field: 'a', action: 'exclude' },
        { field: 'b', action: 'keep', target: 'a.b' },
      ]),
    ).toThrow('a is left out, but a rule writes into it');
  });
});

describe('outputStage', () => {
  it('replaces with $out or merges by _id', () => {
    expect(outputStage('v2', 'replace')).toEqual({ $out: 'v2' });
    expect(outputStage('v2', 'merge')).toEqual({
      $merge: { into: 'v2', on: '_id', whenMatched: 'replace', whenNotMatched: 'insert' },
    });
  });
});
