import { describe, expect, it } from 'vitest';

import { ShellParseError, splitScript, statementAt } from '../src';

/** IntelliShell scripts cut into top-level statements (ADR 0036). */

const texts = (script: string) => splitScript(script).map((s) => s.text);

describe('splitScript', () => {
  it('cuts JavaScript at its top-level statements, across lines and semicolons', () => {
    const script = [
      'db.orders.find({ status: "open" })',
      '  .sort({ total: -1 })',
      'const n = db.orders.countDocuments(); print(n)',
      '',
      'db.orders.aggregate([',
      '  { $match: {} },',
      '])',
    ].join('\n');
    const statements = splitScript(script);
    expect(statements.map((s) => s.text)).toEqual([
      'db.orders.find({ status: "open" })\n  .sort({ total: -1 })',
      'const n = db.orders.countDocuments();',
      'print(n)',
      'db.orders.aggregate([\n  { $match: {} },\n])',
    ]);
    expect(statements.map((s) => s.line)).toEqual([1, 3, 3, 5]);
    expect(statements.every((s) => !s.command)).toBe(true);
    for (const s of statements) expect(script.slice(s.start, s.end)).toBe(s.text);
  });

  it('takes shell commands out as statements of their own', () => {
    const statements = splitScript('use shop\nshow collections;\ndb.orders.find()\nshow dbs');
    expect(statements.map((s) => [s.text, s.command])).toEqual([
      ['use shop', true],
      ['show collections;', true],
      ['db.orders.find()', false],
      ['show dbs', true],
    ]);
  });

  it('keeps what follows a command on its line, and leaves its comment out', () => {
    expect(texts('  use shop; db.orders.findOne()')).toEqual(['use shop;', 'db.orders.findOne()']);
    expect(texts('use shop // the shop\nit')).toEqual(['use shop', 'it']);
  });

  it('reads top-level await, return and identifiers named like commands as JavaScript', () => {
    expect(texts('await db.orders.findOne()\nit\nhelp\nconst use = 1; use + 1')).toEqual([
      'await db.orders.findOne()',
      'it',
      'help',
      'const use = 1;',
      'use + 1',
    ]);
  });

  it('refuses a script with a syntax error, with its position, before anything runs', () => {
    const script = 'db.orders.find()\ndb.orders.find({ total: })';
    let caught: unknown;
    try {
      splitScript(script);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ShellParseError);
    const error = caught as ShellParseError;
    expect(error.line).toBe(2);
    expect(error.offset).toBe(script.indexOf('})'));
    expect(error.message).toMatch(/^Unexpected token \(line 2, column \d+\)$/);
  });

  it('gives an empty list for blank text and comments', () => {
    expect(splitScript('')).toEqual([]);
    expect(splitScript('  // nothing\n/* here */\n')).toEqual([]);
  });
});

describe('statementAt', () => {
  const script = 'db.a.find()\n\ndb.b.find()\n  .limit(5)\n';
  const statements = splitScript(script);

  it('finds the statement under the cursor, at either end too', () => {
    expect(statementAt(statements, 0)?.text).toBe('db.a.find()');
    expect(statementAt(statements, script.indexOf('limit'))?.text).toContain('db.b.find()');
    expect(statementAt(statements, script.indexOf('db.a.find()') + 11)?.text).toBe('db.a.find()');
  });

  it('takes the statement before a blank line, or the first one above the script', () => {
    expect(statementAt(statements, script.indexOf('\n\n') + 1)?.text).toBe('db.a.find()');
    expect(statementAt(statements, script.length)?.text).toContain('db.b.find()');
    expect(statementAt(splitScript('\n\ndb.a.find()'), 0)?.text).toBe('db.a.find()');
    expect(statementAt([], 0)).toBeUndefined();
  });
});
