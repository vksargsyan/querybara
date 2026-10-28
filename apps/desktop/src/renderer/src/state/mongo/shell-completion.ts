/**
 * What IntelliShell's autocompletion completes at the cursor (ADR 0036): the statement's text up
 * to the cursor, which mongosh's own completer takes ("db.orders.fi" → find, findOne...), the word
 * being typed, and the collection whose documents the cursor is inside the braces of, whose field
 * names complete too (`db.orders.find({ cus` → customer). Pure, so it is tested without Monaco.
 */

export interface ShellCompletionContext {
  /** The statement's text up to the cursor (chained lines joined). */
  readonly line: string;
  /** The identifier being typed, which a completion replaces. */
  readonly word: string;
  /** The collection a query, update or pipeline document at the cursor is about. */
  readonly fieldsOf?: { readonly db: string | undefined; readonly collection: string };
}

/** Methods whose document arguments name the collection's fields. */
const FIELD_METHODS = [
  'find',
  'findOne',
  'findOneAndUpdate',
  'findOneAndReplace',
  'findOneAndDelete',
  'countDocuments',
  'count',
  'distinct',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'aggregate',
  'createIndex',
  'watch',
];

const COLLECTION_CALL = new RegExp(
  String.raw`(?:db|db\.getSiblingDB\(\s*(['"])([^'"]+)\1\s*\))\.(?:getCollection\(\s*(['"])([^'"]+)\3\s*\)|([A-Za-z_$][\w$]*))\.(?:${FIELD_METHODS.join('|')})\s*\(`,
  'g',
);

/**
 * The text of the statement the cursor is in, up to the cursor: its line, joined with the lines
 * before when they chain on (a line starting with "." continues the one above).
 */
function statementLine(before: string): string {
  const lines = before.split('\n');
  let index = lines.length - 1;
  let line = lines[index]!;
  while (index > 0 && /^\s*\./.test(line)) {
    index -= 1;
    line = `${lines[index]!.trimEnd()}${line.trim()}`;
  }
  // A line holding several statements: the last one.
  const cut = line.lastIndexOf(';');
  return (cut === -1 ? line : line.slice(cut + 1)).trimStart();
}

/** Whether `text` (after a call's opening parenthesis) leaves the cursor inside braces. */
function insideBraces(text: string): boolean {
  let depth = 0;
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = undefined;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
  }
  return depth > 0 && quote === undefined;
}

export function completionContext(before: string): ShellCompletionContext {
  const line = statementLine(before);
  const word = /[\w$]*$/.exec(line)![0];
  // The last collection call before the cursor, in the text since the last blank line.
  const scope = before.slice(Math.max(0, before.lastIndexOf('\n\n')));
  let fieldsOf: ShellCompletionContext['fieldsOf'];
  for (const match of scope.matchAll(COLLECTION_CALL)) {
    const after = scope.slice(match.index + match[0].length);
    const collection = match[4] ?? match[5];
    if (collection !== undefined && insideBraces(after)) {
      fieldsOf = { db: match[2], collection };
    }
  }
  return { line, word, ...(fieldsOf ? { fieldsOf } : {}) };
}

/**
 * The text a mongosh completion inserts over the word being typed: the candidate past the
 * statement's text before that word; undefined when the candidate does not continue it or is
 * what is typed already.
 */
export function completionInsert(
  context: ShellCompletionContext,
  candidate: string,
): string | undefined {
  const head = context.line.slice(0, context.line.length - context.word.length);
  if (!candidate.startsWith(head)) return undefined;
  const insert = candidate.slice(head.length);
  return insert === '' || insert === context.word ? undefined : insert;
}

/** A field name as a key: bare when it is an identifier, quoted otherwise ("customer.name"). */
export function fieldKey(path: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(path) ? path : JSON.stringify(path);
}
