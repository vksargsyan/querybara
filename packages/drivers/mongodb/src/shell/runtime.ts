import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { types } from 'node:util';
import { createContext, runInContext } from 'node:vm';

import { completer } from '@mongosh/autocomplete';
import { NodeDriverServiceProvider } from '@mongosh/service-provider-node-driver';
import {
  AggregationCursor,
  Cursor,
  RunCommandCursor,
  ShellInstanceState,
  reconstructCursor,
  toShellResult,
  type CursorConstructionOptions,
  type ShellResult,
} from '@mongosh/shell-api';
import { ShellEvaluator } from '@mongosh/shell-evaluator';
import { QuerybaraError, newId } from '@querybara/core';
import {
  ShellParseError,
  commandSafety,
  isBsonDocument,
  parseShell,
  splitScript,
  toEjson,
  type BsonDocument,
  type FindQuery,
  type Namespace,
  type ScriptStatement,
  type ShellCursorQuery,
  type ShellEvent,
  type ShellPrompt,
  type ShellPromptAnswer,
  type ShellStatementRange,
  type ShellValue,
} from '@querybara/mongo-tools';
import type { MongoClient } from 'mongodb';

import { RAW_BSON } from '../context';
import { ADMIN_COMMANDS, CURSOR_COMMANDS } from '../execute';
import { formatPrintable } from './format';
import { ShellWriteRefused, guardServiceProvider, type ShellWrite } from './guard';

/**
 * The embedded mongosh behind IntelliShell (ADR 0036): mongosh's own shell API, evaluator and
 * service provider on a MongoClient the runtime is given, in a JavaScript context of its own, so
 * variables and the current database last from one run to the next.
 *
 * A script runs one top-level statement at a time (see `splitScript`), each giving one result.
 * A find() or aggregate() cursor is taken over before mongosh reads it, recreated with the
 * driver's raw BSON options so its documents keep their exact types (Int32, Double, Long...),
 * and paged on demand as its own result tab: Studio 3T's Query Assist. Every other value is
 * printed as mongosh prints it. Writes go through the write rules (`guard.ts`), which may stop
 * the run to ask the page.
 */

/** The profile's write rules, as the shell applies them. */
export interface ShellWritePolicy {
  readonly connectionName: string;
  readonly readOnly: boolean;
  /** Production profiles and profiles that confirm writes ask before every write. */
  readonly confirmWrites: boolean;
}

/** Where a run's events go, and how it asks the page a question. */
export interface ShellSink {
  emit(event: ShellEvent): void;
  ask(prompt: Omit<ShellPrompt, 'promptId'>): Promise<ShellPromptAnswer>;
}

export interface ShellRuntimeOptions {
  readonly client: MongoClient;
  readonly database: string;
  readonly policy: ShellWritePolicy;
  /** Documents in a cursor result's first page and each page after; default 100. */
  readonly pageSize?: number;
}

/** A cursor result kept open for `more`. */
interface OpenCursor {
  readonly cursor: ShellCursor;
  /** The document read ahead to know whether there are more. */
  peeked: unknown;
}

/** What the runtime uses of a shell-api cursor. */
interface ShellCursor {
  tryNext(): Promise<unknown>;
  close(): Promise<void>;
}

export const DEFAULT_SHELL_PAGE_SIZE = 100;

/** The file name mongosh shows in stack traces of IntelliShell code. */
const FILENAME = 'IntelliShell';

function evaluate(code: string, context: object, filename: string): Promise<unknown> {
  return Promise.resolve(runInContext(code, context, { filename }));
}

function isShellCursor(value: unknown): value is Cursor | AggregationCursor | RunCommandCursor {
  return (
    value instanceof Cursor ||
    value instanceof AggregationCursor ||
    value instanceof RunCommandCursor
  );
}

/** A change stream cursor (db.coll.watch()); its class is not exported by shell-api. */
function isChangeStreamCursor(value: unknown): value is ShellCursor {
  return (
    typeof value === 'object' &&
    value !== null &&
    value.constructor?.name === 'ChangeStreamCursor' &&
    typeof (value as { tryNext?: unknown }).tryNext === 'function'
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  if (types.isDate(value) || types.isRegExp(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  // Objects made in the script's context have that context's Object.prototype.
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}

/** A value shown as documents: a plain object that is not a BSON value. */
function isDocument(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && isBsonDocument(value);
}

function pipelineWrites(pipeline: unknown): boolean {
  if (!Array.isArray(pipeline) || pipeline.length === 0) return false;
  const last: unknown = pipeline[pipeline.length - 1];
  if (!isPlainObject(last)) return false;
  const stage = Object.keys(last)[0];
  return stage === '$out' || stage === '$merge';
}

function optionsWithRawBson(options: unknown): Record<string, unknown> {
  return { ...(isPlainObject(options) ? options : {}), ...RAW_BSON };
}

/**
 * The construction of a cursor with raw BSON options, or undefined when it cannot be recreated
 * without changing what it does: a write pipeline (it already ran) or a command cursor.
 */
function rawConstruction(
  options: CursorConstructionOptions,
): CursorConstructionOptions | undefined {
  switch (options.method) {
    case 'find': {
      const [db, collection, filter, findOptions, dbOptions] = options.args;
      return {
        ...options,
        args: [db, collection, filter, optionsWithRawBson(findOptions), dbOptions],
      } as CursorConstructionOptions;
    }
    case 'aggregate': {
      const [db, collection, pipeline, aggOptions, dbOptions] = options.args;
      if (pipelineWrites(pipeline)) return undefined;
      return {
        ...options,
        args: [db, collection, pipeline, optionsWithRawBson(aggOptions), dbOptions],
      } as CursorConstructionOptions;
    }
    case 'aggregateDb': {
      const [db, pipeline, aggOptions, dbOptions] = options.args;
      if (pipelineWrites(pipeline)) return undefined;
      return {
        ...options,
        args: [db, pipeline, optionsWithRawBson(aggOptions), dbOptions],
      } as CursorConstructionOptions;
    }
    case 'runCursorCommand': {
      const [db, spec, cursorOptions, dbOptions] = options.args;
      if (!isPlainObject(spec) || commandSafety(spec as BsonDocument).writes) return undefined;
      return {
        ...options,
        args: [db, spec, optionsWithRawBson(cursorOptions), dbOptions],
      } as CursorConstructionOptions;
    }
    default:
      return undefined;
  }
}

function ejsonOr(value: unknown, fallback: string): string {
  try {
    return toEjson(value);
  } catch {
    return fallback;
  }
}

/** The query a cursor runs, as Extended JSON, from how mongosh built it and its chains. */
function cursorQuery(
  options: CursorConstructionOptions,
  chains: readonly { readonly method: string; readonly args: readonly unknown[] }[],
): ShellCursorQuery | undefined {
  if (options.method === 'find') {
    const [, , filter, findOptions] = options.args;
    const query: { -readonly [K in keyof FindQuery]: FindQuery[K] } = {
      filter: ejsonOr(filter ?? {}, '{}'),
    };
    const opts: Record<string, unknown> = isPlainObject(findOptions) ? findOptions : {};
    let projection: unknown = opts['projection'];
    let sort: unknown = opts['sort'];
    let skip: unknown = opts['skip'];
    let limit: unknown = opts['limit'];
    for (const chain of chains) {
      const [arg] = chain.args;
      if (chain.method === 'projection' || chain.method === 'project') projection = arg;
      else if (chain.method === 'sort') sort = arg;
      else if (chain.method === 'skip') skip = arg;
      else if (chain.method === 'limit') limit = arg;
    }
    if (projection !== undefined) query.projection = ejsonOr(projection, '{}');
    if (sort !== undefined) query.sort = ejsonOr(sort, '{}');
    if (typeof skip === 'number') query.skip = skip;
    if (typeof limit === 'number') query.limit = limit;
    return { kind: 'find', query };
  }
  if (options.method === 'aggregate' || options.method === 'aggregateDb') {
    const pipeline = options.method === 'aggregate' ? options.args[2] : options.args[1];
    return { kind: 'aggregate', pipeline: ejsonOr(pipeline ?? [], '[]') };
  }
  return undefined;
}

function namespaceOf(options: CursorConstructionOptions | undefined): Namespace | undefined {
  if (!options) return undefined;
  if (options.method === 'find' || options.method === 'aggregate') {
    const [db, collection] = options.args;
    return { db, collection };
  }
  if (options.method === 'runCursorCommand') {
    const [db, spec] = options.args;
    const name = isPlainObject(spec) ? Object.keys(spec)[0] : undefined;
    const target = name === undefined ? undefined : (spec as Record<string, unknown>)[name];
    if ((name === 'find' || name === 'aggregate') && typeof target === 'string') {
      return { db, collection: target };
    }
  }
  return undefined;
}

/**
 * A script that is one command document (`{ find: "orders", filter: {...} }`, in shell syntax or
 * Extended JSON), as the command console ran them: rewritten to run it, through the shell's
 * cursor command (so the reply pages as a cursor) for cursor commands and db.adminCommand for
 * admin-only ones. The document crosses as Extended JSON so its values keep their BSON types.
 * Undefined for any other script.
 */
export function commandScript(script: string): string | undefined {
  const text = script.trim();
  if (!text.startsWith('{')) return undefined;
  let value: unknown;
  try {
    value = parseShell(text);
  } catch {
    return undefined;
  }
  if (!isBsonDocument(value)) return undefined;
  const name = Object.keys(value)[0];
  if (name === undefined) return undefined;
  const method = ADMIN_COMMANDS.has(name)
    ? 'db.adminCommand'
    : CURSOR_COMMANDS.has(name) && value['explain'] === undefined
      ? 'db._runCursorCommand'
      : 'db.runCommand';
  return `${method}(EJSON.parse(${JSON.stringify(toEjson(value))}, { relaxed: false }))`;
}

/** The fields of an error that the page shows. */
function errorFields(error: unknown): {
  message: string;
  name?: string;
  code?: number | string;
  codeName?: string;
} {
  if (!(error instanceof Error)) return { message: String(error) };
  // The app's own refusals (the write rules) speak for themselves.
  if (error instanceof QuerybaraError) return { message: error.message };
  const { code, codeName } = error as { code?: unknown; codeName?: unknown };
  return {
    message: error.message,
    name: error.name,
    ...(typeof code === 'number' || typeof code === 'string' ? { code } : {}),
    ...(typeof codeName === 'string' ? { codeName } : {}),
  };
}

/** The offset in the statement that a Babel syntax error from mongosh points at. */
function errorOffset(error: unknown, statement: ScriptStatement): number | undefined {
  const loc = (error as { loc?: { line?: unknown; column?: unknown } } | null)?.loc;
  if (typeof loc?.line !== 'number' || typeof loc.column !== 'number') return undefined;
  const lines = statement.text.split('\n');
  let offset = 0;
  for (let i = 0; i < loc.line - 1 && i < lines.length; i++) offset += lines[i]!.length + 1;
  return statement.start + Math.min(offset + loc.column, statement.text.length);
}

export class ShellRuntime {
  readonly #client: MongoClient;
  readonly #state: ShellInstanceState;
  readonly #evaluator: ShellEvaluator<ShellResult>;
  readonly #context: object;
  readonly #policy: ShellWritePolicy;
  readonly #pageSize: number;
  readonly #cursors = new Map<string, OpenCursor>();
  readonly #config = new Map<string, unknown>();
  #sink: ShellSink | undefined;
  #running = false;
  #interrupted = false;
  /** Writes of the current run need no more questions ("allow for this run"). */
  #writesAllowed = false;
  /** The collection the last shell API call of the statement worked on. */
  #lastCall: Namespace | undefined;
  /** The cursor result `it` pages. */
  #lastCursor: string | undefined;

  private constructor(options: ShellRuntimeOptions) {
    this.#client = options.client;
    this.#policy = options.policy;
    this.#pageSize = options.pageSize ?? DEFAULT_SHELL_PAGE_SIZE;
    const bus = new EventEmitter();
    const provider = guardServiceProvider(
      new NodeDriverServiceProvider(options.client, bus, {}, undefined),
      (write) => this.#check(write),
    );
    this.#state = new ShellInstanceState(provider, bus);
    this.#state.isInteractive = true;
    this.#state.setEvaluationListener({
      onPrint: (values) => {
        const text = values.map((value) => formatPrintable(value.printable, value.type)).join(' ');
        this.#sink?.emit({ type: 'print', text, stream: 'out' });
      },
      onPrompt: async (question, kind) => {
        const answer = await this.#ask({
          kind: kind === 'password' ? 'password' : 'confirm',
          question,
        });
        if (answer.kind === 'text') return answer.text;
        return answer.kind === 'allow' ? 'yes' : 'no';
      },
      onClearCommand: () => {
        this.#sink?.emit({ type: 'clear' });
      },
      onExit: async () => {
        throw new QuerybaraError({
          code: 'NOT_SUPPORTED',
          message: 'exit does nothing in IntelliShell: close its tab instead',
        });
      },
      getConfig: async (key) => this.#config.get(key) as never,
      setConfig: async (key, value) => {
        this.#config.set(key, value);
        return 'success' as const;
      },
      resetConfig: async (key) => {
        this.#config.delete(key);
        return 'success' as const;
      },
    });
    bus.on(
      'mongosh:api-call-with-arguments',
      (event: { class?: string; db?: string; coll?: string }) => {
        if (event.class === 'Collection' && event.db !== undefined && event.coll !== undefined) {
          this.#lastCall = { db: event.db, collection: event.coll };
        }
      },
    );
    this.#evaluator = new ShellEvaluator<ShellResult>(this.#state, (value: unknown) =>
      // Cursors are kept as they are: mongosh would read their first batch to print it.
      isShellCursor(value) || isChangeStreamCursor(value)
        ? { type: 'Cursor', rawValue: value, printable: undefined }
        : toShellResult(value),
    );
    this.#context = createContext({});
    this.#state.setCtx(this.#context);
  }

  /** A shell on `client`, in `database`. */
  static async open(options: ShellRuntimeOptions): Promise<ShellRuntime> {
    const runtime = new ShellRuntime(options);
    runtime.#state.currentDb.getMongo().use(options.database);
    return runtime;
  }

  /** The database `db` stands for now. */
  get database(): string {
    return this.#state.currentDb._name;
  }

  get running(): boolean {
    return this.#running;
  }

  /** Switches the current database, as `use` does, between runs. */
  useDatabase(database: string): void {
    this.#state.currentDb.getMongo().use(database);
  }

  /**
   * Runs `script`, statement by statement, until the end, an error or an interrupt. Events go to
   * `sink` in order and end with `end`. A script that does not parse runs nothing.
   */
  async evaluate(script: string, sink: ShellSink): Promise<void> {
    if (this.#running) {
      throw new QuerybaraError({ code: 'CONFLICT', message: 'A script is already running here' });
    }
    this.#running = true;
    this.#interrupted = false;
    this.#writesAllowed = false;
    this.#sink = sink;
    this.#state.interrupted.reset();
    const started = performance.now();
    let status: 'success' | 'error' | 'cancelled' = 'success';
    let ran = 0;
    try {
      let statements: ScriptStatement[];
      const command = commandScript(script);
      try {
        statements =
          command === undefined
            ? splitScript(script)
            : [
                {
                  start: script.length - script.trimStart().length,
                  end: script.trimEnd().length,
                  text: command,
                  line: 1,
                  command: false,
                },
              ];
      } catch (error) {
        if (!(error instanceof ShellParseError)) throw error;
        sink.emit({
          type: 'error',
          name: 'SyntaxError',
          message: error.message,
          position: error.offset,
        });
        status = 'error';
        return;
      }
      for (const [index, statement] of statements.entries()) {
        if (this.#interrupted) {
          status = 'cancelled';
          break;
        }
        const range: ShellStatementRange = {
          index,
          start: statement.start,
          end: statement.end,
          line: statement.line,
        };
        const keyword = statement.text.replace(/;\s*$/, '').trim();
        ran += 1;
        if (keyword === 'cls') {
          sink.emit({ type: 'clear' });
          continue;
        }
        if (keyword === 'it') {
          try {
            await this.#iterate(sink);
          } catch (error) {
            status = 'error';
            sink.emit({ type: 'error', ...errorFields(error), statement: range });
            break;
          }
          continue;
        }
        sink.emit({ type: 'statement', ...range });
        const database = this.database;
        this.#lastCall = undefined;
        const begun = performance.now();
        try {
          const result = await this.#evaluator.customEval(
            evaluate,
            statement.text,
            this.#context,
            FILENAME,
          );
          const value = await this.#value(result);
          sink.emit({
            type: 'result',
            ...range,
            source: script.slice(statement.start, statement.end),
            value,
            durationMs: Math.round(performance.now() - begun),
          });
        } catch (error) {
          status = this.#interrupted ? 'cancelled' : 'error';
          const position = errorOffset(error, statement);
          sink.emit({
            type: 'error',
            ...errorFields(error),
            ...(position !== undefined ? { position } : {}),
            statement: range,
          });
          break;
        } finally {
          if (this.database !== database) sink.emit({ type: 'database', name: this.database });
        }
      }
    } finally {
      sink.emit({ type: 'end', status, durationMs: Math.round(performance.now() - started), ran });
      this.#sink = undefined;
      this.#running = false;
      this.#writesAllowed = false;
    }
  }

  /** Stops the running script at the shell's next checkpoint. */
  async interrupt(): Promise<void> {
    if (!this.#running) return;
    this.#interrupted = true;
    await this.#state.interrupted.set();
  }

  /** The next page of a cursor result; it closes once read to the end. */
  async more(
    resultId: string,
    count = this.#pageSize,
  ): Promise<{ readonly documents: string[]; readonly hasMore: boolean }> {
    const open = this.#cursors.get(resultId);
    if (!open) {
      throw new QuerybaraError({
        code: 'NOT_FOUND',
        message: 'That result is closed: run the statement again',
      });
    }
    return this.#page(resultId, open, count);
  }

  /** Closes a cursor result's server cursor (its tab closed). */
  async closeResult(resultId: string): Promise<void> {
    const open = this.#cursors.get(resultId);
    this.#cursors.delete(resultId);
    if (this.#lastCursor === resultId) this.#lastCursor = undefined;
    await open?.cursor.close().catch(() => undefined);
  }

  /**
   * Completions for the text of a statement up to the cursor, as mongosh's own autocompletion
   * gives them: whole candidates for the text ("db.orders.find", "db.orders.findOne").
   */
  async complete(text: string): Promise<string[]> {
    if (text.trim() === '') return [];
    await this.#state.fetchConnectionInfo().catch(() => undefined);
    const [hits] = await completer(this.#state.getAutocompleteParameters(), text);
    return hits;
  }

  async close(): Promise<void> {
    const results = [...this.#cursors.keys()];
    await Promise.allSettled(results.map((id) => this.closeResult(id)));
    await this.#state.close().catch(() => undefined);
    await this.#client.close().catch(() => undefined);
  }

  async #ask(prompt: Omit<ShellPrompt, 'promptId'>): Promise<ShellPromptAnswer> {
    const sink = this.#sink;
    if (!sink) return { kind: 'deny' };
    return sink.ask(prompt);
  }

  /** The write rules for one write: refuse, ask, or let it run. */
  async #check(write: ShellWrite): Promise<void> {
    const policy = this.#policy;
    if (policy.readOnly) {
      throw new ShellWriteRefused(
        `"${policy.connectionName}" is read-only: ${write.operation} on ${write.namespace} was not run`,
      );
    }
    if (!write.destructive && !policy.confirmWrites) return;
    if (this.#writesAllowed) return;
    const answer = await this.#ask({
      kind: write.destructive ? 'destructive' : 'write',
      question: write.destructive
        ? `${write.operation} on ${write.namespace} can remove or change a lot of data. Run it?`
        : `"${policy.connectionName}" asks before every write. Run ${write.operation} on ${write.namespace}?`,
      operation: `${write.operation} ${write.namespace}`,
    });
    if (answer.kind !== 'allow') {
      throw new ShellWriteRefused(`${write.operation} on ${write.namespace} was not run`);
    }
    if (answer.scope === 'run') this.#writesAllowed = true;
  }

  /** What a statement's result shows as. */
  async #value(result: ShellResult): Promise<ShellValue> {
    const raw: unknown = result.rawValue;
    if (isShellCursor(raw)) return this.#cursorValue(raw);
    if (isChangeStreamCursor(raw)) return this.#openCursor(raw, 'changeStream', false, {});
    const printable: unknown = result.printable;
    // findOne(), runCommand() and plain objects; results with types of their own
    // (InsertOneResult, StatsResult...) print as mongosh prints them.
    const documentTypes: readonly (string | null)[] = ['Document', 'CommandResult', null];
    if (documentTypes.includes(result.type) && isDocument(printable)) {
      return {
        kind: 'documents',
        documents: [toEjson(printable)],
        single: true,
        ...(this.#lastCall ? { ns: this.#lastCall } : {}),
      };
    }
    if (result.type === null && Array.isArray(printable) && printable.length > 0) {
      if (printable.every(isDocument)) {
        try {
          return {
            kind: 'documents',
            documents: printable.map((document) => toEjson(document)),
            single: false,
            ...(this.#lastCall ? { ns: this.#lastCall } : {}),
          };
        } catch {
          // Values Extended JSON cannot hold (functions...) print as text instead.
        }
      }
    }
    if (raw === undefined && result.type === null) return { kind: 'none' };
    return { kind: 'text', text: formatPrintable(printable, result.type), shellType: result.type };
  }

  /**
   * A find() or aggregate() cursor as a result: recreated with raw BSON options when it has not
   * been read yet (so its documents keep their exact types), else read as it is.
   */
  async #cursorValue(cursor: Cursor | AggregationCursor | RunCommandCursor): Promise<ShellValue> {
    const options = cursor._constructionOptions;
    const cursorType =
      cursor instanceof Cursor
        ? 'find'
        : cursor instanceof AggregationCursor
          ? 'aggregate'
          : 'command';
    const ns = namespaceOf(options);
    const query = options ? cursorQuery(options, cursor._chains) : undefined;
    const info = { ...(ns ? { ns } : {}), ...(query ? { query } : {}) };
    const raw = options ? rawConstruction(options) : undefined;
    const untouched =
      cursor._transform === null &&
      !cursor._cursor.closed &&
      (cursor._cursor.bufferedCount?.() ?? 0) === 0;
    if (raw && untouched) {
      const typed = reconstructCursor(cursor._mongo, { options: raw, chains: cursor._chains });
      await cursor.close().catch(() => undefined);
      return this.#openCursor(typed, cursorType, true, info);
    }
    return this.#openCursor(cursor, cursorType, false, info);
  }

  async #openCursor(
    cursor: ShellCursor,
    cursorType: 'find' | 'aggregate' | 'command' | 'changeStream',
    exactTypes: boolean,
    info: { readonly ns?: Namespace; readonly query?: ShellCursorQuery },
  ): Promise<ShellValue> {
    const resultId = newId();
    const open: OpenCursor = { cursor, peeked: undefined };
    this.#cursors.set(resultId, open);
    this.#lastCursor = resultId;
    const page = await this.#page(resultId, open, this.#pageSize, cursorType === 'changeStream');
    return { kind: 'cursor', resultId, cursorType, ...info, ...page, exactTypes };
  }

  async #page(
    resultId: string,
    open: OpenCursor,
    count: number,
    endless = false,
  ): Promise<{ documents: string[]; hasMore: boolean }> {
    const documents: string[] = [];
    try {
      while (documents.length < count) {
        const next: unknown = open.peeked !== undefined ? open.peeked : await open.cursor.tryNext();
        open.peeked = undefined;
        if (next === null || next === undefined) break;
        documents.push(toEjson(next));
      }
      if (endless) return { documents, hasMore: true };
      if (documents.length === count) {
        const peeked: unknown = await open.cursor.tryNext();
        if (peeked !== null && peeked !== undefined) {
          open.peeked = peeked;
          return { documents, hasMore: true };
        }
      }
    } catch (error) {
      await this.closeResult(resultId);
      throw error;
    }
    await this.closeResult(resultId);
    return { documents, hasMore: false };
  }

  /** `it`: the next page of the last cursor result. */
  async #iterate(sink: ShellSink): Promise<void> {
    const resultId = this.#lastCursor;
    if (resultId === undefined) {
      sink.emit({ type: 'print', text: 'no cursor', stream: 'out' });
      return;
    }
    const page = await this.more(resultId);
    sink.emit({ type: 'more', resultId, ...page });
  }
}
