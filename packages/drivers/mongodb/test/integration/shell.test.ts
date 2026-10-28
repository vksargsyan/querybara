import {
  EJSON,
  type ShellEvent,
  type ShellPromptAnswer,
  type ShellValue,
} from '@querybara/mongo-tools';
import { MessageChannel } from 'node:worker_threads';

import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ShellClient, buildMongoClientPlan } from '../../src';
import { ShellRuntime, serveShellWorker, type ShellWritePolicy } from '../../src/shell';
import { MONGO_URL, mongoProfile, testDatabase } from './helpers';

/** The embedded mongosh behind IntelliShell (ADR 0036), against the test replica set. */

const DEV: ShellWritePolicy = { connectionName: 'Test', readOnly: false, confirmWrites: false };

interface Run {
  readonly events: ShellEvent[];
  readonly prompts: string[];
}

async function run(
  shell: ShellRuntime,
  script: string,
  answer: (question: string) => ShellPromptAnswer = () => ({ kind: 'deny' }),
): Promise<Run> {
  const events: ShellEvent[] = [];
  const prompts: string[] = [];
  await shell.evaluate(script, {
    emit: (event) => events.push(event),
    ask: async (prompt) => {
      prompts.push(prompt.question);
      return answer(prompt.question);
    },
  });
  return { events, prompts };
}

function values(events: readonly ShellEvent[]): ShellValue[] {
  return events.flatMap((event) => (event.type === 'result' ? [event.value] : []));
}

function end(events: readonly ShellEvent[]) {
  const last = events.at(-1);
  if (last?.type !== 'end') throw new Error('the run did not end');
  return last;
}

function errors(events: readonly ShellEvent[]) {
  return events.flatMap((event) => (event.type === 'error' ? [event] : []));
}

describe.skipIf(!MONGO_URL)('the embedded mongosh', () => {
  const db = testDatabase();
  const clients: MongoClient[] = [];

  async function open(policy: ShellWritePolicy = DEV, pageSize?: number): Promise<ShellRuntime> {
    const plan = buildMongoClientPlan(mongoProfile(MONGO_URL!));
    const client = new MongoClient(plan.url, plan.options);
    await client.connect();
    clients.push(client);
    return ShellRuntime.open({
      client,
      database: db,
      policy,
      ...(pageSize !== undefined ? { pageSize } : {}),
    });
  }

  let shell: ShellRuntime;

  beforeAll(async () => {
    shell = await open(DEV, 3);
    await run(
      shell,
      `db.items.insertMany([
        { _id: 1, n: 5, d: 5.5, i: NumberInt(7), l: NumberLong('9'), dbl: Double(3), at: ISODate('2026-01-01T00:00:00Z') },
        { _id: 2, n: 6 }, { _id: 3, n: 7 }, { _id: 4, n: 8 }, { _id: 5, n: 9 },
      ])`,
    );
  });

  afterAll(async () => {
    await clients[0]
      ?.db(db)
      .dropDatabase()
      .catch(() => undefined);
    await Promise.allSettled(clients.map((client) => client.close()));
  });

  it('runs statement by statement, keeping variables and printing as mongosh does', async () => {
    const { events } = await run(
      shell,
      'const n = db.items.countDocuments()\nprint("count", n)\nn * 2',
    );
    expect(
      events.filter((e) => e.type === 'statement').map((e) => e.type === 'statement' && e.line),
    ).toEqual([1, 2, 3]);
    expect(events).toContainEqual({ type: 'print', text: 'count 5', stream: 'out' });
    expect(values(events)).toEqual([
      { kind: 'none' },
      { kind: 'none' },
      { kind: 'text', text: '10', shellType: null },
    ]);
    expect(end(events)).toMatchObject({ status: 'success', ran: 3 });
    // A later run sees the variable.
    expect(values((await run(shell, 'n')).events)).toEqual([
      { kind: 'text', text: '5', shellType: null },
    ]);
  });

  it('shows a find() as a cursor result with exact BSON types, paged on demand', async () => {
    const { events } = await run(shell, 'db.items.find({}).sort({ _id: 1 })');
    const [value] = values(events);
    if (value?.kind !== 'cursor') throw new Error(`expected a cursor, got ${value?.kind}`);
    expect(value).toMatchObject({
      cursorType: 'find',
      ns: { db, collection: 'items' },
      exactTypes: true,
      hasMore: true,
      query: { kind: 'find', query: { filter: '{}', sort: '{"_id":{"$numberInt":"1"}}' } },
    });
    expect(value.documents).toHaveLength(3);
    const first = JSON.parse(value.documents[0]!) as Record<string, unknown>;
    expect(first).toMatchObject({
      n: { $numberInt: '5' },
      d: { $numberDouble: '5.5' },
      dbl: { $numberDouble: '3.0' },
      l: { $numberLong: '9' },
    });
    const next = await shell.more(value.resultId);
    expect(next.documents.map((d) => (EJSON.parse(d) as { _id: number })._id)).toEqual([4, 5]);
    expect(next.hasMore).toBe(false);
    await expect(shell.more(value.resultId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('pages the last cursor with it, and an aggregate with its pipeline', async () => {
    const { events } = await run(shell, 'db.items.aggregate([{ $match: { n: { $gte: 6 } } }])\nit');
    const [value] = values(events);
    expect(value).toMatchObject({ kind: 'cursor', cursorType: 'aggregate', exactTypes: true });
    expect(value?.kind === 'cursor' && value.query).toEqual({
      kind: 'aggregate',
      pipeline: '[{"$match":{"n":{"$gte":{"$numberInt":"6"}}}}]',
    });
    const more = events.find((e) => e.type === 'more');
    expect(more).toMatchObject({ documents: [expect.any(String)], hasMore: false });
  });

  it('shows findOne() and toArray() as documents, and shell commands as text', async () => {
    const { events } = await run(
      shell,
      'db.items.findOne({ _id: 2 })\ndb.items.find({ _id: { $lt: 3 } }).toArray()\nshow collections',
    );
    const [one, array, collections] = values(events);
    expect(one).toEqual({
      kind: 'documents',
      single: true,
      documents: ['{"_id":{"$numberInt":"2"},"n":{"$numberInt":"6"}}'],
      ns: { db, collection: 'items' },
    });
    expect(array).toMatchObject({
      kind: 'documents',
      single: false,
      documents: [expect.any(String), expect.any(String)],
    });
    expect(collections).toEqual({
      kind: 'text',
      text: 'items',
      shellType: 'ShowCollectionsResult',
    });
  });

  it('switches databases with use, and says so', async () => {
    const other = await open();
    const { events } = await run(other, `use ${db}_other\ndb.getName()`);
    expect(events).toContainEqual({ type: 'database', name: `${db}_other` });
    expect(values(events)).toEqual([
      { kind: 'text', text: `switched to db ${db}_other`, shellType: null },
      { kind: 'text', text: `${db}_other`, shellType: null },
    ]);
    expect(other.database).toBe(`${db}_other`);
  });

  it('runs nothing when the script does not parse, and points at the error', async () => {
    const script = 'db.items.insertOne({ _id: 99 })\ndb.items.find({ n: })';
    const { events } = await run(shell, script);
    expect(events.filter((e) => e.type === 'statement')).toEqual([]);
    expect(errors(events)).toEqual([
      expect.objectContaining({ name: 'SyntaxError', position: script.lastIndexOf('})') }),
    ]);
    expect(
      await clients[0]!.db(db).collection<{ _id: number }>('items').countDocuments({ _id: 99 }),
    ).toBe(0);
  });

  it('stops at the first failing statement with the server error', async () => {
    const { events } = await run(shell, 'db.items.find({ $bad: 1 }).toArray()\nprint("after")');
    expect(errors(events)).toEqual([
      expect.objectContaining({
        name: 'MongoServerError',
        code: 2,
        statement: expect.objectContaining({ line: 1 }),
      }),
    ]);
    expect(events.some((e) => e.type === 'print')).toBe(false);
    expect(end(events)).toMatchObject({ status: 'error', ran: 1 });
  });

  it('runs a command document as the command console did, with exact types', async () => {
    const { events } = await run(
      shell,
      '{ find: "items", filter: { _id: { $lte: 2 } }, sort: { _id: 1 } }',
    );
    const [value] = values(events);
    expect(value).toMatchObject({
      kind: 'cursor',
      cursorType: 'command',
      ns: { db, collection: 'items' },
      exactTypes: true,
    });
    expect(value?.kind === 'cursor' && value.documents[0]).toContain(
      '"dbl":{"$numberDouble":"3.0"}',
    );
    const ping = values((await run(shell, '{ "ping": { "$numberInt": "1" } }')).events)[0];
    expect(ping).toMatchObject({ kind: 'documents', single: true });
    const admin = values((await run(shell, '{ listDatabases: 1, nameOnly: true }')).events)[0];
    expect(admin?.kind === 'documents' && admin.documents[0]).toContain('"databases"');
  });

  it('refuses every write on a read-only connection', async () => {
    const readOnly = await open({ ...DEV, readOnly: true });
    for (const script of [
      'db.items.insertOne({ _id: 100 })',
      'db.items.aggregate([{ $out: "copy" }])',
      'db.runCommand({ drop: "items" })',
      'db.items.drop()',
    ]) {
      const { events } = await run(readOnly, script);
      expect(errors(events)[0]?.message, script).toMatch(/read-only/);
    }
    expect(values((await run(readOnly, 'db.items.countDocuments()')).events)).toEqual([
      { kind: 'text', text: '5', shellType: null },
    ]);
  });

  it('asks before destructive writes, and before every write where the profile says so', async () => {
    const asked = await run(shell, 'db.items.deleteMany({ _id: { $gt: 1000 } })');
    expect(asked.prompts).toEqual([expect.stringMatching(/^deleteMany on .*items can remove/)]);
    expect(errors(asked.events)[0]?.message).toMatch(/was not run/);

    const confirming = await open({ ...DEV, confirmWrites: true });
    const once = await run(
      confirming,
      'db.items.insertOne({ _id: 200 })\ndb.items.insertOne({ _id: 201 })',
      () => ({ kind: 'allow', scope: 'run' }),
    );
    expect(once.prompts).toHaveLength(1);
    expect(end(once.events)).toMatchObject({ status: 'success' });
    const denied = await run(confirming, 'db.items.updateOne({ _id: 200 }, { $set: { x: 1 } })');
    expect(denied.prompts).toHaveLength(1);
    expect(errors(denied.events)[0]?.message).toMatch(/updateOne on .*items was not run/);
  });

  it('completes collections and methods as mongosh does', async () => {
    expect(await shell.complete('db.ite')).toContain('db.items');
    const methods = await shell.complete('db.items.fi');
    expect(methods).toEqual(expect.arrayContaining(['db.items.find', 'db.items.findOne']));
  });

  it('stops a running script when interrupted', async () => {
    const running = run(shell, 'while (true) { db.items.findOne(); sleep(50) }');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await shell.interrupt();
    const { events } = await running;
    expect(end(events).status).toBe('cancelled');
    // The shell works again afterwards.
    expect(values((await run(shell, '1 + 1')).events)).toEqual([
      { kind: 'text', text: '2', shellType: null },
    ]);
  });
});

describe.skipIf(!MONGO_URL)('a shell behind the worker protocol', () => {
  const db = testDatabase();

  /** The worker's loop on the other end of a MessageChannel, in this thread. */
  function start(policy: ShellWritePolicy): Promise<ShellClient> {
    return ShellClient.start({
      spawn: () => {
        const { port1, port2 } = new MessageChannel();
        serveShellWorker(port2);
        return {
          port: port1,
          terminate: async () => port1.close(),
          onExit: () => undefined,
        };
      },
      resolved: mongoProfile(MONGO_URL!),
      database: db,
      policy,
      pageSize: 2,
    });
  }

  it('connects, runs, asks through prompts, pages and completes', async () => {
    const client = await start({ ...DEV, confirmWrites: true });
    try {
      expect(client.info).toMatchObject({ database: db, mongoshVersion: expect.any(String) });
      expect(client.info.serverVersion).toMatch(/^\d+\./);
      const events: ShellEvent[] = [];
      for await (const event of client.evaluate(
        'db.things.insertMany([{ a: 1 }, { a: 2 }, { a: 3 }])\ndb.things.find().sort({ a: 1 })',
      )) {
        events.push(event);
        if (event.type === 'prompt')
          client.answer(event.promptId, { kind: 'allow', scope: 'once' });
      }
      expect(events.filter((e) => e.type === 'prompt')).toHaveLength(1);
      const cursor = values(events)[1];
      if (cursor?.kind !== 'cursor') throw new Error('expected a cursor');
      expect(cursor.documents).toHaveLength(2);
      expect(await client.more(cursor.resultId)).toMatchObject({ hasMore: false });
      expect(await client.complete('db.thi')).toContain('db.things');
      expect(await client.useDatabase('admin')).toBe('admin');
    } finally {
      for await (const event of client.evaluate(`db.getSiblingDB('${db}').dropDatabase()`)) {
        if (event.type === 'prompt')
          client.answer(event.promptId, { kind: 'allow', scope: 'once' });
      }
      await client.close();
    }
  });

  it('fails to start with the connection error', async () => {
    await expect(
      ShellClient.start({
        spawn: () => {
          const { port1, port2 } = new MessageChannel();
          serveShellWorker(port2);
          return { port: port1, terminate: async () => port1.close(), onExit: () => undefined };
        },
        resolved: mongoProfile(MONGO_URL!.replace(/:\/\/[^@]*@/, '://querybara:wrong@'), {
          options: { connectTimeoutMs: 3000 },
        }),
        database: db,
        policy: DEV,
      }),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });
});
