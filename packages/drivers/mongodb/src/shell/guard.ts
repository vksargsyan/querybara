import { QuerybaraError } from '@querybara/core';
import { commandSafety, isBsonDocument, type BsonDocument } from '@querybara/mongo-tools';

/**
 * The write rules for scripts (spec §4, ADR 0036). mongosh reaches the server only through its
 * service provider, so the shell's provider is wrapped: every method that writes is classified
 * (with the command classifier the console and querybara-cli share, for `runCommand`) and handed
 * to a check before it runs. The check refuses on a read-only profile and asks the page for
 * destructive operations, and for every write on profiles that confirm writes.
 *
 * This guards against mistakes, not against the person typing the script: code that digs the
 * driver's client out of the shell's internals goes around it, as it would around any client.
 */

/** One write a script is about to make. */
export interface ShellWrite {
  /** The provider method or command name ("insertOne", "dropDatabase", "createUser"). */
  readonly operation: string;
  /** "db.collection", or the database alone for database-wide operations. */
  readonly namespace: string;
  readonly destructive: boolean;
}

/** Decides one write: resolves to let it run, rejects to refuse it. */
export type WriteCheck = (write: ShellWrite) => Promise<void>;

type Classifier = (args: readonly unknown[]) => ShellWrite | undefined;

function nsOf(args: readonly unknown[]): string {
  const [db, collection] = args;
  return typeof collection === 'string' ? `${String(db)}.${collection}` : String(db);
}

function write(operation: string, destructive = false): Classifier {
  return (args) => ({ operation, namespace: nsOf(args), destructive });
}

function command(args: readonly unknown[]): ShellWrite | undefined {
  const [db, spec] = args;
  if (!isBsonDocument(spec)) return undefined;
  const safety = commandSafety(spec as BsonDocument);
  if (!safety.writes) return undefined;
  const target = safety.name === undefined ? undefined : spec[safety.name];
  return {
    operation: safety.name ?? 'command',
    namespace: typeof target === 'string' ? `${String(db)}.${target}` : String(db),
    destructive: safety.destructive,
  };
}

/** The last stage of a pipeline is $out or $merge. */
function pipelineWrites(pipeline: unknown): boolean {
  if (!Array.isArray(pipeline) || pipeline.length === 0) return false;
  const last: unknown = pipeline[pipeline.length - 1];
  if (!isBsonDocument(last)) return false;
  const stage = Object.keys(last)[0];
  return stage === '$out' || stage === '$merge';
}

function hasBulkModels(requests: unknown, field: 'name' | 'key'): boolean {
  if (!Array.isArray(requests)) return false;
  return requests.some((request: unknown) => {
    if (typeof request !== 'object' || request === null) return false;
    if (field === 'key') return 'deleteMany' in request || 'updateMany' in request;
    const name = (request as { name?: unknown }).name;
    return name === 'deleteMany' || name === 'updateMany';
  });
}

/** Provider methods that write and return a promise: checked before they run. */
const ASYNC_WRITES: Readonly<Record<string, Classifier>> = {
  insertOne: write('insertOne'),
  insertMany: write('insertMany'),
  replaceOne: write('replaceOne'),
  updateOne: write('updateOne'),
  updateMany: write('updateMany', true),
  deleteOne: write('deleteOne'),
  deleteMany: write('deleteMany', true),
  findOneAndDelete: write('findOneAndDelete'),
  findOneAndReplace: write('findOneAndReplace'),
  findOneAndUpdate: write('findOneAndUpdate'),
  bulkWrite: (args) => ({
    operation: 'bulkWrite',
    namespace: nsOf(args),
    destructive: hasBulkModels(args[2], 'key'),
  }),
  clientBulkWrite: (args) => ({
    operation: 'bulkWrite',
    namespace: 'the deployment',
    destructive: hasBulkModels(args[0], 'name'),
  }),
  initializeBulkOp: write('bulk operation', true),
  createIndexes: write('createIndexes'),
  createCollection: write('createCollection'),
  createEncryptedCollection: write('createEncryptedCollection'),
  renameCollection: (args) => {
    const options = args[3];
    const dropTarget =
      typeof options === 'object' &&
      options !== null &&
      (options as { dropTarget?: unknown }).dropTarget === true;
    return { operation: 'renameCollection', namespace: nsOf(args), destructive: dropTarget };
  },
  dropCollection: write('dropCollection', true),
  dropDatabase: write('dropDatabase', true),
  createSearchIndexes: write('createSearchIndexes'),
  updateSearchIndex: write('updateSearchIndex'),
  dropSearchIndex: write('dropSearchIndex', true),
  runCommand: command,
  runCommandWithCheck: command,
};

/** Provider methods that write and return a cursor at once: checked on the first read. */
const CURSOR_WRITES: Readonly<Record<string, Classifier>> = {
  aggregate: (args) =>
    pipelineWrites(args[2])
      ? { operation: 'aggregate ($out/$merge)', namespace: nsOf(args), destructive: false }
      : undefined,
  aggregateDb: (args) =>
    pipelineWrites(args[1])
      ? { operation: 'aggregate ($out/$merge)', namespace: String(args[0]), destructive: false }
      : undefined,
  runCursorCommand: command,
};

/** Cursor methods that make the server run the command. */
const CURSOR_READS = ['hasNext', 'next', 'tryNext', 'toArray', 'forEach'];

/**
 * A cursor whose reads wait for the write check first (once): the provider hands back cursors
 * synchronously, before the check could ask anything.
 */
function guardedCursor(cursor: object, checked: () => Promise<void>): object {
  const guarded: Record<PropertyKey, unknown> = Object.create(Object.getPrototypeOf(cursor));
  for (const key of Reflect.ownKeys(cursor)) {
    const descriptor = Object.getOwnPropertyDescriptor(cursor, key)!;
    Object.defineProperty(guarded, key, descriptor);
  }
  const source = cursor as Record<PropertyKey, unknown>;
  for (const key of CURSOR_READS) {
    const method = source[key];
    if (typeof method !== 'function') continue;
    guarded[key] = async (...args: unknown[]): Promise<unknown> => {
      await checked();
      return (method as (...a: unknown[]) => unknown).apply(cursor, args);
    };
  }
  const iterate = source[Symbol.asyncIterator];
  if (typeof iterate === 'function') {
    guarded[Symbol.asyncIterator] = async function* (): AsyncGenerator<unknown> {
      await checked();
      yield* (iterate as () => AsyncIterable<unknown>).call(cursor);
    };
  }
  return guarded;
}

export class ShellWriteRefused extends QuerybaraError {
  constructor(message: string) {
    super({ code: 'READ_ONLY', message });
    this.name = 'ShellWriteRefused';
  }
}

/**
 * Wraps a mongosh service provider's methods in place so every write goes through `check`.
 * `new Mongo()` and `connect()` are refused: a second connection would leave the profile, its
 * tunnel and these rules behind.
 */
export function guardServiceProvider<P extends object>(provider: P, check: WriteCheck): P {
  const target = provider as Record<string, unknown>;
  for (const [name, classify] of Object.entries(ASYNC_WRITES)) {
    const method = target[name];
    if (typeof method !== 'function') continue;
    target[name] = async (...args: unknown[]): Promise<unknown> => {
      const found = classify(args);
      if (found) await check(found);
      return (method as (...a: unknown[]) => Promise<unknown>).apply(provider, args);
    };
  }
  for (const [name, classify] of Object.entries(CURSOR_WRITES)) {
    const method = target[name];
    if (typeof method !== 'function') continue;
    target[name] = (...args: unknown[]): unknown => {
      const cursor: unknown = (method as (...a: unknown[]) => unknown).apply(provider, args);
      const found = classify(args);
      if (!found || typeof cursor !== 'object' || cursor === null) return cursor;
      let checked: Promise<void> | undefined;
      return guardedCursor(cursor, () => (checked ??= check(found)));
    };
  }
  target['getNewConnection'] = async (): Promise<never> => {
    throw new QuerybaraError({
      code: 'NOT_SUPPORTED',
      message:
        'IntelliShell runs on its own connection: open another connection for another server',
    });
  };
  return provider;
}
