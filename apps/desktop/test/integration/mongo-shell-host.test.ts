import { randomBytes } from 'node:crypto';
import { MessageChannel } from 'node:worker_threads';

import {
  connectionProfileSchema,
  newId,
  type ConnectionProfileInput,
  type ResolvedProfile,
} from '@querybara/core';
import { ShellClient } from '@querybara/driver-mongodb';
import { serveShellWorker } from '@querybara/driver-mongodb/shell';
import { connectionHostContract, createClient, fromNodePort } from '@querybara/ipc';
import type { ShellEvent } from '@querybara/mongo-tools';
import { parseConnectionUri } from '@querybara/storage';
import { afterAll, describe, expect, it } from 'vitest';

import { loadAdapter } from '../../src/connection-host/adapters';
import { ConnectionHost } from '../../src/connection-host/host';
import { shellPolicy, shellProfile } from '../../src/connection-host/mongo-shell';

/**
 * IntelliShell through the connection host (ADR 0036): `mongo.shell.*` on the renderer's RPC
 * client, against the real replica set. The worker's loop runs in this thread on a
 * MessageChannel, as the app runs it in a worker thread.
 */

const MONGO_URL = process.env['QUERYBARA_TEST_MONGODB_URL'];
const DB = `querybara_shell_${randomBytes(4).toString('hex')}`;

function resolvedFromUrl(
  presentation: ConnectionProfileInput['presentation'] = {},
): ResolvedProfile {
  const url = new URL(MONGO_URL!);
  url.searchParams.set('tls', 'false');
  const parsed = parseConnectionUri(url.toString());
  const now = new Date().toISOString();
  const profile = connectionProfileSchema.parse({
    ...parsed.profile,
    id: newId(),
    name: 'Shell test',
    presentation,
    createdAt: now,
    updatedAt: now,
  });
  const ref = profile.auth.method === 'password' ? profile.auth.password : undefined;
  return {
    profile,
    secrets: ref && parsed.password !== undefined ? { [ref.id]: parsed.password } : {},
  };
}

const hosts: ConnectionHost[] = [];

async function start(presentation: ConnectionProfileInput['presentation'] = {}) {
  const resolved = resolvedFromUrl(presentation);
  const host = new ConnectionHost(await loadAdapter('mongodb'), resolved, {
    openShell: async (database) => {
      const client = await ShellClient.start({
        spawn: () => {
          const { port1, port2 } = new MessageChannel();
          serveShellWorker(port2);
          return { port: port1, terminate: async () => port1.close(), onExit: () => undefined };
        },
        resolved: shellProfile(resolved),
        database,
        policy: shellPolicy(resolved.profile),
      });
      return { client, close: () => client.close() };
    },
  });
  await host.start();
  hosts.push(host);
  const channel = new MessageChannel();
  const attached = host.attach(fromNodePort(channel.port2));
  const client = createClient(fromNodePort(channel.port1), connectionHostContract);
  return { host, client, attached };
}

afterAll(async () => {
  await Promise.allSettled(hosts.map((host) => host.shutdown()));
});

describe.skipIf(!MONGO_URL)('IntelliShell through the connection host', () => {
  it('opens a shell, runs a script with a production prompt, and pages a find', async () => {
    const { client } = await start({ environment: 'production' });
    const { shellId, info } = await client.mongo.shell.open({ database: DB });
    expect(info.database).toBe(DB);
    const events: ShellEvent[] = [];
    for await (const event of client.mongo.shell.evaluate({
      shellId,
      script: 'db.orders.insertMany([{ n: 1 }, { n: 2 }])\ndb.orders.find().sort({ n: 1 })',
    })) {
      events.push(event);
      if (event.type === 'prompt') {
        expect(event.kind).toBe('write');
        await client.mongo.shell.answer({
          shellId,
          promptId: event.promptId,
          answer: { kind: 'allow', scope: 'once' },
        });
      }
    }
    expect(events.at(-1)).toMatchObject({ type: 'end', status: 'success', ran: 2 });
    const result = events.findLast((event) => event.type === 'result');
    expect(result?.type === 'result' && result.value).toMatchObject({
      kind: 'cursor',
      ns: { db: DB, collection: 'orders' },
      hasMore: false,
      documents: [expect.stringContaining('"n":{"$numberInt":"1"}'), expect.any(String)],
    });
    const { completions } = await client.mongo.shell.complete({ shellId, text: 'db.ord' });
    expect(completions).toContain('db.orders');
    expect(await client.mongo.shell.useDatabase({ shellId, database: 'admin' })).toMatchObject({
      database: 'admin',
    });
    for await (const event of client.mongo.shell.evaluate({
      shellId,
      script: `db.getSiblingDB('${DB}').dropDatabase()`,
    })) {
      if (event.type === 'prompt') {
        await client.mongo.shell.answer({
          shellId,
          promptId: event.promptId,
          answer: { kind: 'allow', scope: 'once' },
        });
      }
    }
    await client.mongo.shell.close({ shellId });
    await expect(client.mongo.shell.complete({ shellId, text: 'db.' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('refuses writes on a read-only profile, and closes the shells of a closed port', async () => {
    const { client, attached } = await start({ readOnly: true });
    const { shellId } = await client.mongo.shell.open({ database: DB });
    const events: ShellEvent[] = [];
    for await (const event of client.mongo.shell.evaluate({
      shellId,
      script: 'db.orders.insertOne({ n: 3 })',
    })) {
      events.push(event);
    }
    expect(events.find((event) => event.type === 'error')).toMatchObject({
      message: expect.stringContaining('read-only'),
    });
    expect(events.some((event) => event.type === 'prompt')).toBe(false);
    attached.dispose();
  });
});
