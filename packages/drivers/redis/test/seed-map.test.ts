import { createServer, type Server } from 'node:net';

import { connectionProfileSchema, QuerybaraError } from '@querybara/core';
import { afterEach, describe, expect, it } from 'vitest';

import { buildRedisConnectionPlan, createRedisAdapter } from '../src';
import { announcedByMyself } from '../src/seed-map';

const now = '2026-10-05T10:00:00.000Z';

describe('announcedByMyself', () => {
  it('reads the address of the "myself" line', () => {
    const reply = [
      'f5388bb1 192.168.100.101:6379@16379 master - 0 1791227797522 533 connected 0-5460',
      '2ff067db 192.168.100.102:6379@16379 myself,slave f5388bb1 0 1791227796000 533 connected',
      '',
    ].join('\n');
    expect(announcedByMyself(reply)).toEqual([{ host: '192.168.100.102', port: 6379 }]);
  });

  it('adds the hostname, which CLUSTER SLOTS may report instead of the IP', () => {
    const line =
      'abc 10.0.0.5:7000@17000,redis-0.redis.svc,shard-id=1f myself,master - 0 0 1 connected 0-16383';
    expect(announcedByMyself(line)).toEqual([
      { host: '10.0.0.5', port: 7000 },
      { host: 'redis-0.redis.svc', port: 7000 },
    ]);
    // Redis 7.2 leaves the hostname empty and still lists auxiliary fields.
    expect(
      announcedByMyself('abc 10.0.0.5:7000@17000,,shard-id=1f myself,master - 0 0 1 connected'),
    ).toEqual([{ host: '10.0.0.5', port: 7000 }]);
  });

  it('reads IPv6 addresses and lines without a bus port (Redis before 4)', () => {
    expect(announcedByMyself('abc ::1:7000@17000 myself,master - 0 0 1 connected')).toEqual([
      { host: '::1', port: 7000 },
    ]);
    expect(announcedByMyself('abc 10.0.0.5:7000 myself,master - 0 0 1 connected')).toEqual([
      { host: '10.0.0.5', port: 7000 },
    ]);
  });

  it('finds nothing without a myself line or an IP', () => {
    expect(announcedByMyself('abc 10.0.0.5:7000@17000 master - 0 0 1 connected')).toEqual([]);
    expect(announcedByMyself('abc :7000@17000 myself,master - 0 0 0 connected')).toEqual([]);
    expect(announcedByMyself('')).toEqual([]);
  });
});

function profile(port: number, options: Record<string, unknown> = {}) {
  return connectionProfileSchema.parse({
    id: 'p',
    name: 'Cluster',
    engine: 'redis',
    endpoint: { kind: 'cluster', seeds: [{ host: '127.0.0.1', port }] },
    options: { connectTimeoutMs: 2000, ...options },
    createdAt: now,
    updatedAt: now,
  });
}

describe('mapNodesToSeeds in the plan', () => {
  it('is on only for a Cluster profile that asks for it', () => {
    const plan = (p: ReturnType<typeof profile>) =>
      buildRedisConnectionPlan({ profile: p, secrets: {} }).mapNodesToSeeds;
    expect(plan(profile(7000))).toBe(false);
    expect(plan(profile(7000, { mapNodesToSeeds: true }))).toBe(true);
    const standalone = connectionProfileSchema.parse({
      ...profile(7000, { mapNodesToSeeds: true }),
      endpoint: { kind: 'host', host: '127.0.0.1', port: 7000 },
    });
    expect(plan(standalone)).toBe(false);
  });
});

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * A seed that answers CLUSTER SLOTS and CLUSTER NODES as a node announcing `announced`, and
 * OK to anything else (CLIENT SETNAME...). Enough for ioredis to get the slots, not to log in.
 */
async function fakeSeed(announced: { host: string; port: number }): Promise<Server> {
  const bulk = (s: string): string => `$${Buffer.byteLength(s)}\r\n${s}\r\n`;
  const server = createServer((socket) => {
    socket.on('error', () => undefined);
    let buffered = '';
    socket.on('data', (data) => {
      buffered += data.toString('latin1');
      // Commands arrive as RESP arrays of bulk strings.
      for (;;) {
        const m = /^\*(\d+)\r\n/.exec(buffered);
        if (!m) return;
        let at = m[0].length;
        const args: string[] = [];
        for (let i = 0; i < Number(m[1]); i++) {
          const len = /^\$(\d+)\r\n/.exec(buffered.slice(at));
          if (!len) return;
          at += len[0].length;
          if (buffered.length < at + Number(len[1]) + 2) return;
          args.push(buffered.slice(at, at + Number(len[1])));
          at += Number(len[1]) + 2;
        }
        buffered = buffered.slice(at);
        const command = args.map((a) => a.toLowerCase()).join(' ');
        if (command === 'cluster slots') {
          socket.write(
            `*1\r\n*3\r\n:0\r\n:16383\r\n*3\r\n${bulk(announced.host)}:${announced.port}\r\n${bulk('a'.repeat(40))}`,
          );
        } else if (command === 'cluster nodes') {
          socket.write(
            bulk(
              `${'a'.repeat(40)} ${announced.host}:${announced.port}@1 myself,master - 0 0 1 connected 0-16383\n`,
            ),
          );
        } else {
          socket.write('+OK\r\n');
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return server;
}

describe('a Cluster whose nodes cannot be reached as they announce themselves', () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  it('fails to connect, naming the nodes, instead of waiting forever', async () => {
    const unreachable = { host: '127.0.0.1', port: await closedPort() };
    server = await fakeSeed(unreachable);
    const seed = (server.address() as { port: number }).port;
    const started = Date.now();
    const error = await createRedisAdapter()
      .connect({ profile: profile(seed), secrets: {} })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(QuerybaraError);
    expect((error as QuerybaraError).message).toBe(
      `The cluster seeds answered, but the node they announce could not be reached: 127.0.0.1:${unreachable.port}`,
    );
    expect((error as QuerybaraError).hint).toMatch(/Reach nodes through the seed addresses/);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
