import { createServer, type Socket } from 'node:net';

import {
  connectionProfileSchema,
  type ConnectionCheckResult,
  type ResolvedProfile,
} from '@querybara/core';
import { BSON } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkMongoConnection } from '../src/check';
import { MongoDbSession } from '../src/session';

const OP_REPLY = 1;
const OP_MSG = 2013;

/** A message header: length, request id, the request it answers, opcode. */
function header(opCode: number, responseTo: number, bodyLength: number): Buffer {
  const out = Buffer.alloc(16);
  out.writeInt32LE(16 + bodyLength, 0);
  out.writeInt32LE(0, 4);
  out.writeInt32LE(responseTo, 8);
  out.writeInt32LE(opCode, 12);
  return out;
}

/**
 * A server that answers every message with MongoDB 4.2's handshake reply (wire versions 0 to
 * 8): the legacy `ismaster` over OP_QUERY gets an OP_REPLY, anything over OP_MSG an OP_MSG.
 */
async function fakeMongo42(): Promise<{ readonly port: number; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    let buffered = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 16 && buffered.length >= buffered.readInt32LE(0)) {
        const requestId = buffered.readInt32LE(4);
        const opCode = buffered.readInt32LE(12);
        buffered = buffered.subarray(buffered.readInt32LE(0));
        const body = BSON.serialize({
          ismaster: true,
          maxBsonObjectSize: 16_777_216,
          maxMessageSizeBytes: 48_000_000,
          maxWriteBatchSize: 100_000,
          localTime: new Date(),
          logicalSessionTimeoutMinutes: 30,
          connectionId: 1,
          minWireVersion: 0,
          maxWireVersion: 8,
          readOnly: false,
          ok: 1,
        });
        if (opCode === OP_MSG) {
          // flagBits, then one body section (kind 0).
          socket.write(
            Buffer.concat([header(OP_MSG, requestId, 5 + body.length), Buffer.alloc(5), body]),
          );
        } else {
          // responseFlags, cursorID, startingFrom, numberReturned = 1.
          const prefix = Buffer.alloc(20);
          prefix.writeInt32LE(1, 16);
          socket.write(
            Buffer.concat([header(OP_REPLY, requestId, 20 + body.length), prefix, body]),
          );
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    port: address.port,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

let server: Awaited<ReturnType<typeof fakeMongo42>>;
beforeAll(async () => {
  server = await fakeMongo42();
});
afterAll(async () => {
  await server.close();
});

function resolved(): ResolvedProfile {
  const profile = connectionProfileSchema.parse({
    id: 'p',
    name: 'mongo@stage',
    engine: 'mongodb',
    endpoint: { kind: 'host', host: '127.0.0.1', port: server.port },
    auth: { method: 'password', user: 'ada', password: { id: 'pw' } },
    tls: { mode: 'disable' },
    options: { connectTimeoutMs: 10_000 },
    createdAt: '2026-11-17T10:00:00.000Z',
    updatedAt: '2026-11-17T10:00:00.000Z',
  });
  return { profile, secrets: { pw: 'hunter2' } };
}

describe('a MongoDB server older than the driver supports (4.2)', () => {
  it('fails at once, naming the server release and the oldest supported one', async () => {
    const started = performance.now();
    const failure = await MongoDbSession.open(resolved()).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(failure).toMatchObject({
      code: 'NOT_SUPPORTED',
      message: `127.0.0.1:${server.port} runs MongoDB 4.2, which is older than Querybara supports`,
      hint: expect.stringMatching(/MongoDB 4\.4 and later/),
    });
  });

  it('reports it as the server version step of Test Connection', async () => {
    const started = performance.now();
    const steps: ConnectionCheckResult[] = [];
    for await (const step of checkMongoConnection(resolved(), {
      connect: (profile) => MongoDbSession.open(profile),
    })) {
      steps.push(step);
    }
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(steps.map((s) => [s.step, s.status])).toEqual([
      ['dns', 'skipped'],
      ['tcp', 'ok'],
      ['ssh', 'skipped'],
      ['tls', 'skipped'],
      ['auth', 'skipped'],
      ['ping', 'skipped'],
      ['version', 'failed'],
    ]);
    expect(steps.at(-1)).toMatchObject({
      message: expect.stringContaining('runs MongoDB 4.2'),
      hint: expect.stringContaining('4.4'),
    });
  });
});
