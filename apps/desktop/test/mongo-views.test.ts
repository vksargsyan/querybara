import {
  QuerybaraError,
  connectionProfileSchema,
  toColumnChunk,
  type ConnectionProfileInput,
  type ResultChunk,
} from '@querybara/core';
import type { StoredProfile } from '@querybara/ipc';
import {
  fromEjson,
  toEjson,
  type DocumentPage,
  type FindQuery,
  type ShellEvent,
} from '@querybara/mongo-tools';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { HostClient } from '../src/renderer/src/lib/main-client';
import { useConnections } from '../src/renderer/src/state/connections';
import { keys, queryClient } from '../src/renderer/src/state/data';
import { useDialogs, type Prompt } from '../src/renderer/src/state/dialogs';
import { CollectionView } from '../src/renderer/src/state/mongo/collection-view';
import { DEFAULT_DOCUMENT_PAGE } from '../src/renderer/src/state/mongo/pages';
import { IntelliShell } from '../src/renderer/src/state/mongo/intellishell';
import { profileInput } from './helpers';

/**
 * The collection view and IntelliShell driven against a fake connection host (spec §9, ADR 0036):
 * the query bar and find() text kept in step, pages fetched as the view scrolls, the editor's
 * conflict flow, bulk writes counted before they run, deletes, explain, and IntelliShell's result
 * tabs, raw output and questions.
 */

interface Call {
  readonly method: string;
  readonly input: Record<string, unknown>;
}

const PROFILE_ID = 'mongo-profile';

function stored(presentation: ConnectionProfileInput['presentation'] = {}): StoredProfile {
  return {
    ...connectionProfileSchema.parse(
      profileInput({
        id: PROFILE_ID,
        name: 'Shop',
        engine: 'mongodb',
        endpoint: { kind: 'host', host: 'localhost', port: 27017 },
        presentation,
      }),
    ),
    version: 1,
  };
}

/** The events each IntelliShell run of the fake host streams, in order. */
let shellRuns: ShellEvent[][] = [];

/** A connection host whose collection holds `count` orders; it records every call. */
function fakeHost(count: number) {
  const calls: Call[] = [];
  let documents = Array.from({ length: count }, (_, i) => toEjson({ _id: i + 1, total: i * 10 }));
  const record = (method: string, input: object): void => {
    calls.push({ method, input: input as Record<string, unknown> });
  };
  const summary = (partial: object) => ({
    dryRun: false,
    matchedCount: 0,
    modifiedCount: 0,
    deletedCount: 0,
    ...partial,
  });
  const host = {
    openSession: async () => ({ sessionId: 's1' }),
    closeSession: async () => undefined,
    cancel: async (input: object) => record('cancel', input),
    browse: async () => [
      { kind: 'database', name: 'shop', path: ['shop'], hasChildren: true },
      { kind: 'database', name: 'admin', path: ['admin'], hasChildren: true },
    ],
    execute: (input: { text: string }) => {
      record('execute', input);
      return (async function* (): AsyncGenerator<ResultChunk> {
        if (input.text.includes('boom')) {
          throw new QuerybaraError({
            code: 'VALIDATION_FAILED',
            message: 'Unexpected }',
            position: 7,
          });
        }
        yield {
          type: 'columns',
          resultIndex: 0,
          columns: [{ name: 'document', nativeType: 'document', kind: 'json' }],
        };
        yield toColumnChunk(0, 1, [[toEjson({ ok: 1 })]]);
        yield { type: 'status', command: 'ping', rowsAffected: null };
        yield { type: 'end', durationMs: 3, rowCount: 1 };
      })();
    },
    mongo: {
      shell: {
        open: async (input: object) => {
          record('shell.open', input);
          return {
            shellId: 'sh1',
            info: { database: 'shop', mongoshVersion: '5.9.5', serverVersion: '8.0.4' },
          };
        },
        evaluate: (input: { script: string }) => {
          record('shell.evaluate', input);
          const events = shellRuns.shift() ?? [];
          return (async function* (): AsyncGenerator<ShellEvent> {
            yield* events;
          })();
        },
        answer: async (input: object) => record('shell.answer', input),
        more: async (input: object) => {
          record('shell.more', input);
          return { documents: [toEjson({ _id: 3 })], hasMore: false };
        },
        closeResult: async (input: object) => record('shell.closeResult', input),
        complete: async () => ({ completions: ['db.orders'] }),
        interrupt: async (input: object) => record('shell.interrupt', input),
        close: async (input: object) => record('shell.close', input),
      },
      serverInfo: async () => ({
        version: '8.0.4',
        topology: 'replicaSet',
        members: [],
        modules: [],
      }),
      useDatabase: async (input: object) => record('useDatabase', input),
      find: (input: { query: FindQuery; pageSize?: number }) => {
        record('find', input);
        const size = input.pageSize ?? 1000;
        const filter = input.query.filter;
        const filtered =
          filter && filter.includes('_id')
            ? documents.filter((doc) => filter === `{"_id":${JSON.stringify(JSON.parse(doc)._id)}}`)
            : documents;
        const skip = input.query.skip ?? 0;
        const limit = input.query.limit ?? 0;
        const matching = filtered.slice(skip, limit > 0 ? skip + limit : undefined);
        return (async function* (): AsyncGenerator<DocumentPage> {
          for (let i = 0; i < matching.length; i += size)
            yield { documents: matching.slice(i, i + size) };
        })();
      },
      estimatedCount: async () => ({ count: documents.length }),
      count: async (input: object) => {
        record('count', input);
        return { count: documents.length };
      },
      explain: async (input: object) => {
        record('explain', input);
        return {
          plan: { id: '1', operation: 'COLLSCAN', detail: { collectionScan: true }, children: [] },
          summary: { collectionScan: true, indexes: [], nReturned: documents.length },
          raw: '{}',
        };
      },
      replaceOne: async (input: { original: string; replacement: string }) => {
        record('replaceOne', input);
        const at = documents.indexOf(input.original);
        if (at < 0) {
          const id = JSON.parse(input.original)._id;
          const current = documents.find(
            (doc) => JSON.stringify(JSON.parse(doc)._id) === JSON.stringify(id),
          );
          throw new QuerybaraError({
            code: 'CONFLICT',
            message: 'The document changed',
            detail: current!,
          });
        }
        documents[at] = input.replacement;
        return summary({ matchedCount: 1, modifiedCount: 1 });
      },
      insertOne: async (input: { document: string }) => {
        record('insertOne', input);
        documents.push(input.document);
        return { insertedId: '"x"' };
      },
      deleteOne: async (input: { id: string }) => {
        record('deleteOne', input);
        const before = documents.length;
        documents = documents.filter((doc) => JSON.stringify(JSON.parse(doc)._id) !== input.id);
        return summary({ deletedCount: before - documents.length, matchedCount: 1 });
      },
      updateMany: async (input: { dryRun?: boolean }) => {
        record('updateMany', input);
        return summary({
          dryRun: input.dryRun === true,
          matchedCount: documents.length,
          modifiedCount: input.dryRun ? 0 : documents.length,
        });
      },
      deleteMany: async (input: { dryRun?: boolean }) => {
        record('deleteMany', input);
        const n = documents.length;
        if (!input.dryRun) documents = [];
        return summary({
          dryRun: input.dryRun === true,
          matchedCount: n,
          deletedCount: input.dryRun ? 0 : n,
        });
      },
    },
  };
  return {
    host: host as unknown as HostClient,
    calls,
    change(id: number, patch: object) {
      documents = documents.map((doc) => {
        const value = JSON.parse(doc) as { _id: { $numberInt: string } };
        return Number(value._id.$numberInt) === id
          ? toEjson({ ...(fromEjson(doc) as object), ...patch })
          : doc;
      });
    },
  };
}

/** Answers the confirmations the views ask, recording their titles and commands. */
let answer = true;
const asked: { title: string; detail?: string }[] = [];
let unsubscribe: () => void = () => undefined;

function connectTo(
  host: HostClient,
  presentation: ConnectionProfileInput['presentation'] = {},
): void {
  queryClient.setQueryData(keys.profiles, [stored(presentation)]);
  useConnections.setState({
    byProfile: {
      [PROFILE_ID]: {
        profileId: PROFILE_ID,
        status: 'ready',
        host,
        generation: 1,
        connectionId: 'c1',
      },
    },
  });
}

beforeEach(() => {
  answer = true;
  asked.length = 0;
  unsubscribe = useDialogs.subscribe((state) => {
    const prompt: Prompt | undefined = state.queue[0];
    if (prompt?.kind !== 'confirm') return;
    asked.push({
      title: prompt.title,
      ...(prompt.detail !== undefined ? { detail: prompt.detail } : {}),
    });
    prompt.resolve(answer);
  });
});

afterEach(() => {
  unsubscribe();
  useConnections.setState({ byProfile: {} });
  queryClient.clear();
});

function view(): CollectionView {
  return new CollectionView('panel', {
    profileId: PROFILE_ID,
    db: 'shop',
    collection: 'orders',
    kind: 'collection',
  });
}

describe('collection view', () => {
  it('keeps the fields and the find() text in step, both ways', () => {
    const v = view();
    expect(v.state.findText).toBe('db.orders.find({})');
    v.setField('filter', '{ total: { $gt: 100 } }');
    v.setField('sort', '{ total: -1 }');
    expect(v.state.findText).toBe('db.orders.find({ total: { $gt: 100 } }).sort({ total: -1 })');
    v.setField('limit', 'x');
    expect(v.state.issues.limit).toMatchObject({ message: 'Limit must be a whole number' });
    // The text keeps the last valid query while a field is wrong.
    expect(v.state.findText).toBe('db.orders.find({ total: { $gt: 100 } }).sort({ total: -1 })');
    v.setFindText("db.orders.find({ status: 'open' }, { total: 1 }).limit(5)");
    expect(v.state.fields).toEqual({
      filter: "{ status: 'open' }",
      projection: '{ total: 1 }',
      sort: '',
      skip: '',
      limit: '5',
    });
    expect(v.state.issues).toEqual({});
    v.setFindText("db.orders.find({ status: 'open' }");
    expect(v.state.findIssue).toMatchObject({ line: 1 });
    expect(v.state.fields.filter).toBe("{ status: 'open' }");
  });

  it('shows one page at a time: next, last (counted first), a page by number, a new size', async () => {
    const fake = fakeHost(250);
    connectTo(fake.host);
    const v = view();
    await v.init();
    // Canonical Extended JSON: { _id: { $numberInt: "101" } }.
    const ids = (): number[] =>
      v.results.state.documents.map((doc) =>
        Number((JSON.parse(doc) as { _id: { $numberInt: string } })._id.$numberInt),
      );
    const lastFind = () => fake.calls.filter((c) => c.method === 'find').at(-1)!.input;
    expect(v.results.state.documents).toHaveLength(DEFAULT_DOCUMENT_PAGE);
    expect(v.state).toMatchObject({ page: 1, pageSize: 100, hasNext: true });
    await expect.poll(() => v.state.estimate).toBe(250);

    await v.goToPage('next');
    expect(lastFind()).toMatchObject({ query: { skip: 100, limit: 100 }, pageSize: 100 });
    expect(v.state.page).toBe(2);
    expect(ids()[0]).toBe(101);
    expect(v.results.state.offset).toBe(100);

    await v.goToPage('last');
    expect(v.state.exactCount).toBe(250);
    expect(v.state).toMatchObject({ page: 3, hasNext: false });
    expect(ids()).toHaveLength(50);
    expect(lastFind()).toMatchObject({ query: { skip: 200, limit: 100 } });

    await v.goToPage(1);
    expect(ids()[0]).toBe(1);
    await v.setPageSize(500);
    expect(v.state).toMatchObject({ page: 1, pageSize: 500, hasNext: false });
    expect(ids()).toHaveLength(250);
    await v.dispose();
  });

  it('edits a document, shows a concurrent change as a conflict, and overwrites after asking', async () => {
    const fake = fakeHost(3);
    connectTo(fake.host);
    const v = view();
    await v.init();
    v.openEditor('edit', 0);
    expect(v.state.editor).toMatchObject({ mode: 'edit', index: 0, text: '{ _id: 1, total: 0 }' });
    fake.change(1, { total: 42, by: 'someone else' });
    v.setEditorText('{ _id: 1, total: 7 }');
    expect(await v.saveEditor()).toBe(false);
    expect(v.state.editor).toMatchObject({
      status: 'conflict',
      current: { text: "{ _id: 1, total: 42, by: 'someone else' }" },
    });
    expect(await v.overwriteEditor()).toBe(true);
    expect(asked.at(-1)).toMatchObject({ title: 'Overwrite the newer version?' });
    expect(v.state.editor).toBeUndefined();
    expect(v.results.state.documents[0]).toBe(toEjson({ _id: 1, total: 7 }));
    expect(v.state.notice).toMatchObject({ kind: 'success', text: 'Document saved' });

    v.openEditor('clone', 1);
    expect(v.state.editor?.text).toBe('{ total: 10 }');
    expect(await v.saveEditor()).toBe(true);
    expect(fake.calls.find((c) => c.method === 'insertOne')?.input).toMatchObject({
      document: '{"total":{"$numberInt":"10"}}',
    });
  });

  it('counts a bulk update with a dry run, then writes after the confirmation', async () => {
    const fake = fakeHost(4);
    connectTo(fake.host);
    const v = view();
    v.setField('filter', "{ status: 'open' }");
    await v.init();
    v.openBulk('update');
    v.setBulkUpdateText('{ $set: { flagged: true } }');
    await v.countBulk();
    expect(v.state.bulk).toMatchObject({ step: 'counted', matched: 4 });
    expect(await v.runBulk()).toBe(true);
    expect(asked.at(-1)).toEqual({
      title: 'Update 4 documents?',
      detail:
        "db.getSiblingDB('shop').orders.updateMany({ status: 'open' }, { $set: { flagged: true } })",
    });
    const updates = fake.calls.filter((c) => c.method === 'updateMany').map((c) => c.input);
    expect(updates).toMatchObject([
      { dryRun: true, filter: '{"status":"open"}' },
      { dryRun: false, confirmed: true, update: '{"$set":{"flagged":true}}' },
    ]);

    answer = false;
    v.openBulk('delete');
    await expect.poll(() => v.state.bulk?.step).toBe('counted');
    expect(await v.runBulk()).toBe(false);
    expect(fake.calls.filter((c) => c.method === 'deleteMany')).toHaveLength(1);
  });

  it('deletes one document after showing its command, and explains the query', async () => {
    const fake = fakeHost(2);
    connectTo(fake.host);
    const v = view();
    await v.init();
    await v.deleteDocument(1);
    expect(asked.at(-1)).toEqual({
      title: 'Delete this document?',
      detail: "db.getSiblingDB('shop').orders.deleteOne({ _id: 2 })",
    });
    expect(v.results.state.documents).toHaveLength(1);
    await v.explain('queryPlanner');
    expect(v.state.section).toBe('explain');
    expect(v.state.explain).toMatchObject({
      verbosity: 'queryPlanner',
      result: { summary: { collectionScan: true } },
    });
    expect(fake.calls.find((c) => c.method === 'explain')?.input).toMatchObject({
      target: { kind: 'find', query: { filter: '{}' } },
      verbosity: 'queryPlanner',
    });
  });

  it('writes nothing on a read-only profile, and asks before every write on production', async () => {
    const readOnly = fakeHost(2);
    connectTo(readOnly.host, { readOnly: true });
    const v = view();
    await v.init();
    v.openEditor('edit', 0);
    expect(v.state.editor).toBeUndefined();
    expect(v.state.notice).toMatchObject({ text: 'This connection is read-only.' });
    await v.deleteDocument(0);
    expect(readOnly.calls.some((c) => c.method === 'deleteOne')).toBe(false);

    const production = fakeHost(2);
    connectTo(production.host, { environment: 'production' });
    const p = view();
    await p.init();
    p.openEditor('insert');
    p.setEditorText('{ total: 1 }');
    answer = false;
    expect(await p.saveEditor()).toBe(false);
    expect(asked.at(-1)).toEqual({
      title: 'Insert the document?',
      detail: "db.getSiblingDB('shop').orders.insertOne({ total: 1 })",
    });
    answer = true;
    expect(await p.saveEditor()).toBe(true);
    expect(production.calls.find((c) => c.method === 'insertOne')?.input).toMatchObject({
      confirmed: true,
    });
  });
});

/** A cursor result event, as the host sends one for a find() on line `line` (at `start`). */
function cursorResult(line: number, resultId: string, hasMore: boolean, start = 0): ShellEvent {
  return {
    type: 'result',
    index: 0,
    start,
    end: start + 16,
    line,
    source: 'db.orders.find()',
    durationMs: 2,
    value: {
      kind: 'cursor',
      resultId,
      cursorType: 'find',
      ns: { db: 'shop', collection: 'orders' },
      query: { kind: 'find', query: { filter: '{}' } },
      documents: [toEjson({ _id: 1 }), toEjson({ _id: 2 })],
      hasMore,
      exactTypes: true,
    },
  };
}

const END: ShellEvent = { type: 'end', status: 'success', durationMs: 5, ran: 1 };

describe('IntelliShell', () => {
  beforeEach(() => {
    shellRuns = [];
  });

  it('opens a shell, prints, and gives each find() a result tab that pages on demand', async () => {
    const fake = fakeHost(0);
    connectTo(fake.host);
    const shell = new IntelliShell('shell', { profileId: PROFILE_ID, database: 'shop' });
    await shell.init();
    expect(shell.state).toMatchObject({
      status: 'ready',
      database: 'shop',
      mongoshVersion: '5.9.5',
    });
    shell.setText('print("hi")\ndb.orders.find()');
    shellRuns.push([
      { type: 'statement', index: 0, start: 0, end: 11, line: 1 },
      { type: 'print', text: 'hi', stream: 'out' },
      { type: 'statement', index: 1, start: 12, end: 28, line: 2 },
      cursorResult(2, 'r1', true, 12),
      END,
    ]);
    await shell.run('all');
    expect(fake.calls.find((c) => c.method === 'shell.evaluate')?.input).toMatchObject({
      shellId: 'sh1',
      script: 'print("hi")\ndb.orders.find()',
    });
    expect(shell.state.output.map((line) => [line.kind, line.text])).toEqual(
      expect.arrayContaining([
        ['input', '> print("hi")'],
        ['print', 'hi'],
        ['input', '> db.orders.find()'],
      ]),
    );
    const [tab] = shell.state.tabs;
    expect(tab).toMatchObject({ title: 'Find Query (line 2)', resultId: 'r1', pinned: false });
    expect(shell.state.active).toBe(tab!.id);
    expect(tab!.results.state.documents).toHaveLength(2);
    await shell.fetchMore(tab!.id);
    expect(tab!.results.state.documents).toHaveLength(3);
    expect(shell.state.tabs[0]!.resultId).toBeUndefined();
    expect(shell.state.lastRun).toEqual({ status: 'success', durationMs: 5, ran: 1 });
  });

  it('replaces unpinned tabs on the next run, keeps pinned ones, and closes their cursors', async () => {
    const fake = fakeHost(0);
    connectTo(fake.host);
    const shell = new IntelliShell('shell', { profileId: PROFILE_ID, database: 'shop' });
    await shell.init();
    shell.setText('db.orders.find()');
    shellRuns.push([cursorResult(1, 'r1', true), END], [cursorResult(1, 'r2', true), END]);
    await shell.run('all');
    shell.togglePin(shell.state.tabs[0]!.id);
    await shell.run('all');
    expect(shell.state.tabs.map((t) => t.resultId)).toEqual(['r1', 'r2']);
    shellRuns.push([END]);
    shell.togglePin(shell.state.tabs[0]!.id);
    await shell.run('all');
    expect(shell.state.tabs).toEqual([]);
    expect(
      fake.calls.filter((c) => c.method === 'shell.closeResult').map((c) => c.input['resultId']),
    ).toEqual(['r1', 'r2']);
  });

  it('prints cursors as text with Query Assist off, and marks an error where it points', async () => {
    const fake = fakeHost(0);
    connectTo(fake.host);
    const shell = new IntelliShell('shell', { profileId: PROFILE_ID, database: 'shop' });
    await shell.init();
    shell.setQueryAssist(false);
    shell.setText('db.a.find()\n\ndb.orders.find()');
    shellRuns.push([cursorResult(1, 'r1', true), END]);
    await shell.run('statement', { cursor: 15 });
    expect(fake.calls.at(-1)?.input).toMatchObject({ script: 'db.orders.find()' });
    expect(shell.state.tabs).toEqual([]);
    expect(shell.state.output.map((line) => line.text)).toEqual(
      expect.arrayContaining(['{ _id: 1 }\n{ _id: 2 }', 'Type "it" for more']),
    );
    shellRuns.push([
      { type: 'error', name: 'SyntaxError', message: 'Unexpected token', position: 4 },
      { type: 'end', status: 'error', durationMs: 0, ran: 0 },
    ]);
    await shell.run('statement', { cursor: 15 });
    expect(shell.state.errorMarker).toEqual({
      offset: 'db.a.find()\n\n'.length + 4,
      message: 'SyntaxError: Unexpected token',
    });
  });

  it('asks the questions a script asks, and passes the answer on', async () => {
    const fake = fakeHost(0);
    connectTo(fake.host, { environment: 'production' });
    const shell = new IntelliShell('shell', { profileId: PROFILE_ID, database: 'shop' });
    await shell.init();
    const questions: unknown[] = [];
    const stop = useDialogs.subscribe((state) => {
      const prompt = state.queue[0];
      if (prompt?.kind !== 'shell') return;
      questions.push({ ...prompt.prompt, production: prompt.production });
      prompt.resolve({ kind: 'allow', scope: 'run' });
    });
    shell.setText('db.orders.insertOne({})');
    shellRuns.push([
      {
        type: 'prompt',
        promptId: 'p1',
        kind: 'write',
        question: 'Run insertOne on shop.orders?',
        operation: 'insertOne shop.orders',
      },
      END,
    ]);
    await shell.run('all');
    stop();
    expect(questions).toEqual([
      {
        kind: 'write',
        question: 'Run insertOne on shop.orders?',
        operation: 'insertOne shop.orders',
        production: true,
      },
    ]);
    expect(fake.calls.find((c) => c.method === 'shell.answer')?.input).toEqual({
      shellId: 'sh1',
      promptId: 'p1',
      answer: { kind: 'allow', scope: 'run' },
    });
    await shell.dispose();
    expect(fake.calls.at(-1)).toMatchObject({ method: 'shell.close', input: { shellId: 'sh1' } });
  });
});
