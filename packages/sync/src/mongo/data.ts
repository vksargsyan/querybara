import { cancelledError, QuerybaraError } from '@querybara/core';
import type {
  BsonDocument,
  BsonValue,
  DocumentPage,
  FindQuery,
  Namespace,
} from '@querybara/mongo-tools';
import { EJSON, formatShell } from '@querybara/mongo-tools';

import type { MergeSummary, RowDiff } from '../data/merge';
import { canonicalBson, compareBson } from './bson';

/**
 * MongoDB data compare (spec §13, data sync for documents): both collections are read in `_id`
 * order with the simple collation, merged in MongoDB's BSON order, and each `_id` present on
 * both sides is compared document to document. Differences come out as the SQL compare's
 * RowDiff with two "columns": `_id` and the whole document, both canonical Extended JSON, so
 * the spool, grid and apply code paths are shared; `changedColumns` lists the top-level fields
 * that differ.
 *
 * Views and time series collections hold no `_id`-ordered documents to compare and are left
 * to the caller to skip.
 */

/** What compare reads from a MongoDB session. */
export interface MongoFindSession {
  find(
    ns: Namespace,
    query: FindQuery,
    opts?: { pageSize?: number; signal?: AbortSignal },
  ): AsyncIterable<DocumentPage>;
}

/** The two "columns" of a document row. */
export const DOCUMENT_COLUMNS = ['_id', 'document'] as const;

/** A collection on each side. */
export interface CollectionPair {
  readonly source: Namespace;
  readonly target: Namespace;
  /** Top-level fields left out of the comparison (they are still copied by inserts and updates). */
  readonly ignoreFields?: readonly string[];
}

export interface MongoDataCompareOptions {
  /** Documents whose fields differ only in order are equal (default true). */
  readonly ignoreFieldOrder?: boolean;
  /** Int32 1, Long 1 and Double 1.0 are equal (default false: the sync copies the types). */
  readonly ignoreNumericTypes?: boolean;
  /** Documents per fetched page (default 1000). */
  readonly pageSize?: number;
  readonly signal?: AbortSignal;
}

export type MongoDataCompareEvent =
  | { readonly type: 'progress'; readonly rowsCompared: number }
  | { readonly type: 'diff'; readonly diff: RowDiff }
  | { readonly type: 'done'; readonly summary: MergeSummary };

/** A document as read: its text, its parsed JSON (not yet BSON) and its `_id`. */
interface Doc {
  readonly text: string;
  readonly json: Record<string, unknown>;
  readonly id: BsonValue;
  readonly idText: string;
}

function readDoc(text: string, side: string): Doc {
  const json = JSON.parse(text) as Record<string, unknown>;
  if (!('_id' in json)) {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: `A document in the ${side} has no _id`,
    });
  }
  const id = EJSON.deserialize({ v: json['_id'] }, { relaxed: false })['v'] as BsonValue;
  return { text, json, id, idText: JSON.stringify(json['_id']) };
}

/** Reads one side in `_id` order, checking the order the merge relies on. */
class DocStream {
  private readonly iterator: AsyncIterator<DocumentPage>;
  private page: readonly string[] = [];
  private position = 0;
  private previous: Doc | undefined;
  count = 0;

  constructor(
    session: MongoFindSession,
    ns: Namespace,
    private readonly side: 'source' | 'target',
    options: MongoDataCompareOptions,
  ) {
    const pages = session.find(
      ns,
      {
        filter: '{}',
        sort: '{"_id":1}',
        // Binary string order whatever the collection's default collation, and no time limit:
        // a whole collection is read.
        collation: '{"locale":"simple"}',
        maxTimeMS: 0,
      },
      {
        pageSize: options.pageSize ?? 1000,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      },
    );
    this.iterator = pages[Symbol.asyncIterator]();
  }

  private take(): Doc | undefined {
    if (this.position >= this.page.length) return undefined;
    const doc = readDoc(this.page[this.position++]!, this.side);
    if (this.previous !== undefined && compareBson(this.previous.id, doc.id) >= 0) {
      throw new QuerybaraError({
        code: 'VALIDATION_FAILED',
        message: `The ${this.side} documents did not come back in _id order (at ${doc.idText})`,
      });
    }
    this.previous = doc;
    this.count++;
    return doc;
  }

  async next(): Promise<Doc | undefined> {
    for (;;) {
      const doc = this.take();
      if (doc !== undefined) return doc;
      const result = await this.iterator.next();
      if (result.done) return undefined;
      this.page = result.value.documents;
      this.position = 0;
    }
  }

  /** The next document without awaiting when the current page holds one. */
  nextSync(): Doc | undefined {
    return this.take();
  }

  async close(): Promise<void> {
    await this.iterator.return?.();
  }
}

/** Top-level fields whose values differ, in source order then target-only fields. */
function changedFields(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  options: MongoDataCompareOptions,
  ignored: ReadonlySet<string>,
): string[] {
  const canonical = (value: unknown): string =>
    canonicalBson(EJSON.deserialize({ v: value }, { relaxed: false })['v'] as BsonValue, options);
  const changed: string[] = [];
  for (const field of Object.keys(a)) {
    if (ignored.has(field)) continue;
    if (!(field in b)) changed.push(field);
    else if (JSON.stringify(a[field]) !== JSON.stringify(b[field])) {
      if (canonical(a[field]) !== canonical(b[field])) changed.push(field);
    }
  }
  for (const field of Object.keys(b)) {
    if (!ignored.has(field) && !(field in a)) changed.push(field);
  }
  if (changed.length === 0 && options.ignoreFieldOrder === false) {
    const order = (doc: Record<string, unknown>): string =>
      Object.keys(doc)
        .filter((f) => !ignored.has(f))
        .join('\u0000');
    if (order(a) !== order(b)) changed.push('(field order)');
  }
  return changed;
}

/**
 * Compares one collection's documents between two MongoDB sessions. Yields one diff event per
 * differing `_id` (insert: only in the source, delete: only in the target, update: both,
 * different), progress every page or so, and a final summary, which is also the return value.
 */
export async function* compareCollectionData(
  source: MongoFindSession,
  target: MongoFindSession,
  pair: CollectionPair,
  options: MongoDataCompareOptions = {},
): AsyncGenerator<MongoDataCompareEvent, MergeSummary, undefined> {
  const ignored = new Set(pair.ignoreFields ?? []);
  ignored.delete('_id');
  const left = new DocStream(source, pair.source, 'source', options);
  const right = new DocStream(target, pair.target, 'target', options);
  const totals = { inserts: 0, updates: 0, deletes: 0, equal: 0 };
  const progressEvery = Math.max(1, options.pageSize ?? 1000);
  let sinceProgress = 0;
  const row = (doc: Doc): string[] => [doc.idText, doc.text];
  try {
    let a = left.nextSync() ?? (await left.next());
    let b = right.nextSync() ?? (await right.next());
    while (a !== undefined || b !== undefined) {
      if (options.signal?.aborted) throw cancelledError();
      const order = a === undefined ? 1 : b === undefined ? -1 : compareBson(a.id, b.id);
      if (order < 0) {
        totals.inserts++;
        yield { type: 'diff', diff: { action: 'insert', key: [a!.idText], sourceRow: row(a!) } };
        a = left.nextSync() ?? (await left.next());
      } else if (order > 0) {
        totals.deletes++;
        yield { type: 'diff', diff: { action: 'delete', key: [b!.idText], targetRow: row(b!) } };
        b = right.nextSync() ?? (await right.next());
      } else {
        const same = a!.text === b!.text && ignored.size === 0;
        const changed = same ? [] : changedFields(a!.json, b!.json, options, ignored);
        if (changed.length > 0) {
          totals.updates++;
          yield {
            type: 'diff',
            diff: {
              action: 'update',
              key: [a!.idText],
              changedColumns: changed,
              sourceRow: row(a!),
              targetRow: row(b!),
            },
          };
        } else {
          totals.equal++;
        }
        a = left.nextSync() ?? (await left.next());
        b = right.nextSync() ?? (await right.next());
      }
      if (++sinceProgress >= progressEvery) {
        sinceProgress = 0;
        yield { type: 'progress', rowsCompared: left.count + right.count };
      }
    }
  } finally {
    await left.close();
    await right.close();
  }
  const summary: MergeSummary = {
    ...totals,
    sourceRows: left.count,
    targetRows: right.count,
  };
  yield { type: 'done', summary };
  return summary;
}

// ---------------------------------------------------------------------------------------------
// Sync commands

export interface MongoDataSyncOptions {
  /** The target collection the commands write to. */
  readonly collection: string;
  /** Documents per command (default 500). */
  readonly batchSize?: number;
  /** Text size at which a command is closed early (default 4 MiB, well under BSON's 16). */
  readonly maxCommandBytes?: number;
}

const parseDocText = (text: string): BsonDocument =>
  EJSON.parse(text, { relaxed: false }) as BsonDocument;

/**
 * Turns row differences into MongoDB write commands, batched: `insert` for documents only in
 * the source, `delete` by `_id` for documents only in the target, and `update` with a
 * replacement document and `upsert` (so a document deleted meanwhile is put back) for changed
 * ones. Statements are command documents in shell syntax, which a session runs as they are and
 * which `db.runCommand(...)` runs in mongosh.
 */
export class MongoDataSyncScriptBuilder {
  private readonly batchSize: number;
  private readonly maxBytes: number;
  private readonly entries: { action: RowDiff['action']; entry: BsonDocument }[] = [];
  private bytes = 0;

  constructor(private readonly options: MongoDataSyncOptions) {
    this.batchSize = Math.max(1, options.batchSize ?? 500);
    this.maxBytes = options.maxCommandBytes ?? 4 * 1024 * 1024;
  }

  /** Adds one difference; returns the commands that became full, ready to run or write. */
  add(diff: RowDiff): string[] {
    const out: string[] = [];
    const action = diff.action;
    if (this.entries.length > 0 && this.entries[0]!.action !== action) out.push(...this.flush());
    const text = action === 'delete' ? String(diff.key[0]) : String(diff.sourceRow?.[1] ?? '');
    let entry: BsonDocument;
    if (action === 'insert') entry = parseDocText(text);
    else if (action === 'delete') entry = { q: { _id: parseId(text) }, limit: 1 };
    else {
      const doc = parseDocText(text);
      entry = { q: { _id: doc['_id']! }, u: doc, upsert: true };
    }
    this.entries.push({ action, entry });
    this.bytes += text.length;
    if (this.entries.length >= this.batchSize || this.bytes >= this.maxBytes) {
      out.push(...this.flush());
    }
    return out;
  }

  /** The command for what is pending, if anything. */
  flush(): string[] {
    if (this.entries.length === 0) return [];
    const action = this.entries[0]!.action;
    const entries = this.entries.map((e) => e.entry);
    this.entries.length = 0;
    this.bytes = 0;
    const collection = this.options.collection;
    const command: BsonDocument =
      action === 'insert'
        ? { insert: collection, documents: entries }
        : action === 'delete'
          ? { delete: collection, deletes: entries }
          : { update: collection, updates: entries };
    return [formatShell(command)];
  }
}

function parseId(idText: string): BsonValue {
  return EJSON.deserialize({ v: JSON.parse(idText) }, { relaxed: false })['v'] as BsonValue;
}

/** The mongosh lines that run `statements` against `database`. */
export function mongoScript(database: string, statements: readonly string[]): string {
  return [
    `db = db.getSiblingDB(${JSON.stringify(database)});`,
    ...statements.map((s) => `db.runCommand(${s});`),
  ].join('\n');
}

/** The display text of an `_id` (shell syntax, as the grid shows values). */
export function idDisplay(idText: string): string {
  return formatShell(parseId(idText), { lineWidth: Infinity });
}
