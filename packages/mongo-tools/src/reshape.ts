import { QuerybaraError } from '@querybara/core';

import type { BsonDocument, BsonValue } from './bson';
import { parseShell } from './shell/parser';

/**
 * Studio 3T's Reschema and Data Masking (ADR 0038): rules per field, compiled into an
 * aggregation pipeline that the server runs into another collection (`$out` or `$merge`), so
 * the documents never leave it. A rule keeps a field (under a new path, which moves or nests
 * it), converts its type, leaves it out, or masks it: characters hidden, a fixed value, null,
 * numbers or dates moved by a random amount within a spread. A computed rule adds a field from
 * an aggregation expression.
 *
 * The pipeline is a `$set` of every value that changes, an `$unset` of what is left out or
 * moved away, and, when only the listed fields are kept, a `$project` of them.
 */

export const RESHAPE_ACTIONS = [
  'keep',
  'convert',
  'exclude',
  'mask',
  'fixed',
  'null',
  'random-number',
  'random-date',
  'computed',
] as const;
export type ReshapeAction = (typeof RESHAPE_ACTIONS)[number];

/** Types a field converts to, as `$convert` names them. */
export const RESHAPE_TYPES = [
  'string',
  'int',
  'long',
  'double',
  'decimal',
  'bool',
  'date',
  'objectId',
] as const;
export type ReshapeType = (typeof RESHAPE_TYPES)[number];

export interface ReshapeRule {
  /** The source field's dotted path; empty for a computed field. */
  readonly field: string;
  readonly action: ReshapeAction;
  /** Where the value goes; the source path by default. */
  readonly target?: string;
  /** `convert`: the new type. */
  readonly type?: ReshapeType;
  /** `mask`: characters left showing at the start and the end, and the mask character. */
  readonly keepStart?: number;
  readonly keepEnd?: number;
  readonly maskChar?: string;
  /** `fixed`: the value, in mongosh syntax. `computed`: the expression, in mongosh syntax. */
  readonly value?: string;
  /** `random-number`: ± percent of the value. `random-date`: ± days. */
  readonly spread?: number;
}

export interface ReshapeOptions {
  /** Keep only the fields the rules write (and `_id`, unless a rule leaves it out). */
  readonly onlyListed?: boolean;
}

function invalid(rule: number, message: string): QuerybaraError {
  return new QuerybaraError({
    code: 'VALIDATION_FAILED',
    message: `Rule ${rule + 1}: ${message}`,
  });
}

const PATH = /^[^$.][^.]*(\.[^$.][^.]*)*$/;

/** Builds a mask of `count` characters (an expression). */
function repeat(count: BsonValue, char: string): BsonDocument {
  return {
    $reduce: {
      input: { $range: [0, { $max: [count, 0] }] },
      initialValue: '',
      in: { $concat: ['$$value', char] },
    },
  };
}

function maskExpression(input: string, start: number, end: number, char: string): BsonDocument {
  const masked: BsonDocument = {
    $let: {
      vars: { n: { $strLenCP: '$$s' } },
      in: {
        $cond: [
          { $lte: ['$$n', start + end] },
          repeat('$$n', char),
          {
            $concat: [
              { $substrCP: ['$$s', 0, start] },
              repeat({ $subtract: ['$$n', start + end] }, char),
              { $substrCP: ['$$s', { $subtract: ['$$n', end] }, end] },
            ],
          },
        ],
      },
    },
  };
  return {
    $let: {
      vars: { s: input },
      in: { $cond: [{ $eq: [{ $type: '$$s' }, 'string'] }, masked, '$$s'] },
    },
  };
}

/** A random factor in [1 - spread, 1 + spread]. */
function randomFactor(spread: number): BsonDocument {
  return {
    $add: [1, { $multiply: [{ $subtract: [{ $multiply: [{ $rand: {} }, 2] }, 1] }, spread] }],
  };
}

function randomNumber(input: string, percent: number): BsonDocument {
  return {
    $let: {
      vars: { v: input },
      in: {
        $cond: [
          { $isNumber: '$$v' },
          {
            $let: {
              vars: { r: { $multiply: ['$$v', randomFactor(percent / 100)] } },
              in: {
                $switch: {
                  branches: [
                    {
                      // Whole numbers stay whole, in their own type.
                      case: { $in: [{ $type: '$$v' }, ['int', 'long']] },
                      then: { $convert: { input: { $round: ['$$r', 0] }, to: { $type: '$$v' } } },
                    },
                    { case: { $eq: [{ $type: '$$v' }, 'decimal'] }, then: { $toDecimal: '$$r' } },
                  ],
                  default: '$$r',
                },
              },
            },
          },
          '$$v',
        ],
      },
    },
  };
}

function randomDate(input: string, days: number): BsonDocument {
  return {
    $let: {
      vars: { v: input },
      in: {
        $cond: [
          { $eq: [{ $type: '$$v' }, 'date'] },
          {
            $add: [
              '$$v',
              {
                $round: [
                  {
                    $multiply: [
                      { $subtract: [{ $multiply: [{ $rand: {} }, 2] }, 1] },
                      days * 86_400_000,
                    ],
                  },
                  0,
                ],
              },
            ],
          },
          '$$v',
        ],
      },
    },
  };
}

function parsed(rule: number, text: string | undefined, what: string): BsonValue {
  if (text === undefined || text.trim() === '') throw invalid(rule, `give the ${what}`);
  try {
    return parseShell(text);
  } catch (error) {
    throw invalid(
      rule,
      `the ${what} does not parse: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The value a rule writes to its target, or undefined when the field stays as it is. */
function expressionOf(rule: ReshapeRule, index: number): BsonValue | undefined {
  const input = `$${rule.field}`;
  switch (rule.action) {
    case 'keep':
      return rule.target === undefined || rule.target === rule.field ? undefined : input;
    case 'exclude':
      return undefined;
    case 'convert':
      if (rule.type === undefined) throw invalid(index, 'choose the type to convert to');
      return { $convert: { input, to: rule.type, onError: input, onNull: null } };
    case 'mask': {
      const start = Math.max(0, Math.floor(rule.keepStart ?? 0));
      const end = Math.max(0, Math.floor(rule.keepEnd ?? 0));
      const char = rule.maskChar ?? '*';
      if ([...char].length !== 1) throw invalid(index, 'the mask is one character');
      return maskExpression(input, start, end, char);
    }
    case 'fixed':
      return { $literal: parsed(index, rule.value, 'value') };
    case 'null':
      return { $literal: null };
    case 'random-number': {
      const spread = rule.spread ?? 10;
      if (!(spread >= 0 && spread <= 1000)) throw invalid(index, 'the spread is 0 to 1000 percent');
      return randomNumber(input, spread);
    }
    case 'random-date': {
      const spread = rule.spread ?? 30;
      if (!(spread >= 0 && spread <= 365_000))
        throw invalid(index, 'the spread is a number of days');
      return randomDate(input, spread);
    }
    case 'computed':
      return parsed(index, rule.value, 'expression');
  }
}

const isWithin = (path: string, parent: string): boolean =>
  path === parent || path.startsWith(`${parent}.`);

/**
 * The stages that apply the rules, without the stage that writes the output. Throws
 * VALIDATION_FAILED naming the rule that cannot work.
 */
export function reshapeStages(
  rules: readonly ReshapeRule[],
  options: ReshapeOptions = {},
): BsonDocument[] {
  const set: BsonDocument = {};
  const unset = new Set<string>();
  const kept: string[] = [];
  const targets: string[] = [];
  rules.forEach((rule, index) => {
    const computed = rule.action === 'computed';
    if (!computed && !PATH.test(rule.field))
      throw invalid(index, `"${rule.field}" is not a field path`);
    const target = (rule.target ?? '').trim() || rule.field;
    if (rule.action === 'exclude') {
      unset.add(rule.field);
      return;
    }
    if (!PATH.test(target)) throw invalid(index, `"${target}" is not a field path`);
    if (target === '_id' && rule.field !== '_id') {
      throw invalid(index, 'only the _id field writes _id');
    }
    for (const other of targets) {
      if (isWithin(target, other) || isWithin(other, target)) {
        throw invalid(index, `${target} and ${other} would overwrite each other`);
      }
    }
    targets.push(target);
    kept.push(target);
    const expression = expressionOf({ ...rule, target }, index);
    if (expression !== undefined) set[target] = expression;
    if (!computed && target !== rule.field) {
      if (isWithin(target, rule.field)) {
        throw invalid(index, `${rule.field} cannot move inside itself`);
      }
      unset.add(rule.field);
    }
  });
  // A moved-away source that another rule writes into stays.
  for (const path of [...unset]) {
    if (targets.some((target) => isWithin(target, path) || isWithin(path, target))) {
      if (rules.some((rule) => rule.action === 'exclude' && rule.field === path)) {
        throw new QuerybaraError({
          code: 'VALIDATION_FAILED',
          message: `${path} is left out, but a rule writes into it`,
        });
      }
      unset.delete(path);
    }
  }
  const stages: BsonDocument[] = [];
  if (Object.keys(set).length > 0) stages.push({ $set: set });
  if (unset.size > 0) stages.push({ $unset: [...unset] });
  if (options.onlyListed) {
    const project: BsonDocument = {};
    if (unset.has('_id')) project['_id'] = 0;
    for (const path of kept) project[path] = 1;
    if (Object.keys(project).length > 0) stages.push({ $project: project });
  }
  return stages;
}

export const RESHAPE_OUTPUT_MODES = ['replace', 'merge'] as const;
export type ReshapeOutputMode = (typeof RESHAPE_OUTPUT_MODES)[number];

/**
 * The stage that writes the reshaped documents: `$out` replaces the target collection (made
 * when missing), `$merge` replaces documents with the same `_id` and adds the rest.
 */
export function outputStage(target: string, mode: ReshapeOutputMode): BsonDocument {
  return mode === 'replace'
    ? { $out: target }
    : { $merge: { into: target, on: '_id', whenMatched: 'replace', whenNotMatched: 'insert' } };
}
