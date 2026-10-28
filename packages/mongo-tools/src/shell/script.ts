import { parse, type Options } from 'acorn';

import { ShellParseError, locationAt } from './errors';

/**
 * mongosh scripts cut into their top-level statements (IntelliShell, ADR 0036). The shell runs a
 * script one statement at a time, so each find() or aggregate() can show its own result tab, and
 * the editor runs the statement at the cursor. JavaScript is parsed with acorn; mongosh's shell
 * commands (`use shop`, `show dbs`) are not JavaScript, so a line that starts with one is taken
 * out as a statement of its own when the parser stops on it.
 */

export interface ScriptStatement {
  /** 0-based offset of the first character in the script. */
  readonly start: number;
  /** 0-based offset just past the last character (a trailing semicolon included). */
  readonly end: number;
  readonly text: string;
  /** 1-based line of `start`. */
  readonly line: number;
  /** A shell command line (`use`, `show`...) that mongosh reads as words, not JavaScript. */
  readonly command: boolean;
}

const ACORN: Options = {
  ecmaVersion: 'latest',
  sourceType: 'script',
  allowAwaitOutsideFunction: true,
  allowReturnOutsideFunction: true,
  allowHashBang: true,
};

/** Shell commands that take words after them, which JavaScript cannot parse. */
const COMMAND_LINE = /^(?:use|show|help|exit|quit)\s+[^\s.(=[`]/;

interface Range {
  readonly start: number;
  readonly end: number;
}

interface AcornSyntaxError extends SyntaxError {
  readonly pos: number;
}

function isAcornError(error: unknown): error is AcornSyntaxError {
  return error instanceof SyntaxError && typeof (error as { pos?: unknown }).pos === 'number';
}

/**
 * The shell command on the line holding `offset`: the line from its first non-blank character to
 * its first semicolon (or a `//` comment, or the line's end). Undefined when the line does not
 * start with one.
 */
function commandLineAt(text: string, offset: number): Range | undefined {
  let lineStart = offset;
  while (lineStart > 0 && text[lineStart - 1] !== '\n' && text[lineStart - 1] !== '\r') {
    lineStart -= 1;
  }
  let start = lineStart;
  while (start < text.length && (text[start] === ' ' || text[start] === '\t')) start += 1;
  let lineEnd = start;
  while (lineEnd < text.length && text[lineEnd] !== '\n' && text[lineEnd] !== '\r') lineEnd += 1;
  const line = text.slice(start, lineEnd);
  if (!COMMAND_LINE.test(line)) return undefined;
  const cut = [line.indexOf(';'), line.indexOf('//')].filter((i) => i !== -1);
  const length = cut.length === 0 ? line.length : Math.min(...cut);
  let end = start + length;
  while (end > start && /\s/.test(text[end - 1]!)) end -= 1;
  // The semicolon that ends the command goes with it.
  const after = text.indexOf(';', end);
  if (after !== -1 && after < lineEnd && text.slice(end, after).trim() === '') end = after + 1;
  return { start, end };
}

function blankOut(text: string, range: Range): string {
  return text.slice(0, range.start) + ' '.repeat(range.end - range.start) + text.slice(range.end);
}

/** The reason of an acorn error, without its "(line:column)" suffix. */
function reasonOf(error: AcornSyntaxError): string {
  return error.message.replace(/\s*\(\d+:\d+\)$/, '');
}

/**
 * The script's top-level statements in order. Throws ShellParseError (with the offset) when the
 * script is not valid mongosh, before anything runs, as mongosh's `load()` does.
 */
export function splitScript(text: string): ScriptStatement[] {
  let masked = text;
  const commands: Range[] = [];
  let ranges: Range[];
  for (;;) {
    try {
      ranges = parse(masked, ACORN).body.map((node) => ({ start: node.start, end: node.end }));
      break;
    } catch (error) {
      if (!isAcornError(error)) throw error;
      const command = commandLineAt(masked, Math.min(error.pos, masked.length));
      if (!command || commands.some((c) => c.start === command.start)) {
        throw new ShellParseError(text, error.pos, reasonOf(error));
      }
      commands.push(command);
      masked = blankOut(masked, command);
    }
  }
  const statements = [
    ...ranges.map((range) => ({ ...range, command: false })),
    ...commands.map((range) => ({ ...range, command: true })),
  ].sort((a, b) => a.start - b.start);
  return statements.map(({ start, end, command }) => ({
    start,
    end,
    text: text.slice(start, end),
    line: locationAt(text, start).line,
    command,
  }));
}

/**
 * The statement the editor's cursor is in: the one whose text holds `offset`, else the last one
 * before it, else the first one after it (a cursor above the first statement).
 */
export function statementAt(
  statements: readonly ScriptStatement[],
  offset: number,
): ScriptStatement | undefined {
  let before: ScriptStatement | undefined;
  for (const statement of statements) {
    if (offset >= statement.start && offset <= statement.end) return statement;
    if (statement.end <= offset) before = statement;
  }
  return before ?? statements[0];
}
