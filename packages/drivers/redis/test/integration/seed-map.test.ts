import { createServer, connect as dial, type Socket } from 'node:net';

import { keySlot, type RedisReply } from '@querybara/redis-tools';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  REDIS_CLUSTER,
  REDIS_URL,
  cleanup,
  clusterProfile,
  connect,
  dec,
  newPrefix,
} from './helpers';

/**
 * A Cluster reached only through a port per node, as behind Kubernetes NodePorts: each test
 * node gets a TCP proxy, the profile lists the proxies as seeds, and with "map nodes to seeds"
 * every node connection must go through its proxy while the nodes keep their announced names.
 */

interface Proxy {
  readonly port: number;
  /** Local ports of the proxy's connections to the node, as the node sees them come from. */
  readonly upstreamPorts: Set<number>;
  close(): Promise<void>;
}

async function proxyTo(host: string, port: number): Promise<Proxy> {
  const upstreamPorts = new Set<number>();
  const sockets = new Set<Socket>();
  const server = createServer((client) => {
    const upstream = dial(port, host);
    upstream.on('connect', () => upstreamPorts.add(upstream.localPort!));
    for (const s of [client, upstream]) {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
      s.on('error', () => undefined);
    }
    client.pipe(upstream).pipe(client);
    client.on('close', () => upstream.destroy());
    upstream.on('close', () => client.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    port: (server.address() as { port: number }).port,
    upstreamPorts,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        sockets.forEach((s) => s.destroy());
      }),
  };
}

function text(reply: RedisReply): string {
  return reply.type === 'bulk' || reply.type === 'verbatim' ? dec(reply.value)! : '';
}

describe.skipIf(!REDIS_CLUSTER || !REDIS_URL)('Cluster nodes reached through the seeds', () => {
  const nodes = (REDIS_CLUSTER ?? '').split(',').map((s) => s.trim());
  const proxies = new Map<string, Proxy>();

  beforeAll(async () => {
    for (const node of nodes) {
      const [host, port] = node.split(':') as [string, string];
      proxies.set(node, await proxyTo(host, Number(port)));
    }
  });
  afterAll(async () => {
    await Promise.all([...proxies.values()].map((p) => p.close()));
  });

  function mappedProfile(applicationName: string) {
    const seeds = [...proxies.values()].map((p) => ({ host: '127.0.0.1', port: p.port }));
    return clusterProfile({
      endpoint: { kind: 'cluster', seeds },
      options: { mapNodesToSeeds: true, applicationName },
    });
  }

  it('reaches every node through its seed and names nodes as they announce themselves', async () => {
    const name = `qb-seedmap-${Date.now()}`;
    const session = await connect(mappedProfile(name));
    const p = newPrefix();
    try {
      expect(session.nodes().map((n) => n.address)).toEqual([...nodes].sort());
      const view = await session.topology();
      expect(
        view.nodes
          .filter((n) => n.role === 'primary')
          .map((n) => n.address)
          .sort(),
      ).toEqual([...nodes].sort());

      // Keys on every primary, written and read back through the cluster client.
      const keys = Array.from({ length: 60 }, (_, i) => `${p}k:${i}`);
      await Promise.all(keys.map((k, i) => session.setString(k, String(i))));
      for (const k of keys) await session.command(['GET', k]);

      // Every connection of this session that a node sees came from that node's proxy.
      for (const node of nodes) {
        const list = text(await session.command(['CLIENT', 'LIST'], { node }));
        const ours = list
          .split('\n')
          .filter((line) => new RegExp(` name=${name}(-\\S*)? `).test(line))
          .map((line) => Number(/ addr=\S+:(\d+) /.exec(line)![1]));
        expect(ours.length).toBeGreaterThan(0);
        for (const port of ours) expect(proxies.get(node)!.upstreamPorts).toContain(port);
      }
    } finally {
      await cleanup(session, p);
      await session.close();
    }
  });

  it('follows a MOVED (which names the announced address) through the seed', async () => {
    const session = await connect(mappedProfile(`qb-seedmap-moved-${Date.now()}`));
    const p = newPrefix();
    try {
      const key = `${p}moved`;
      const view = await session.topology();
      const slot = keySlot(key);
      const owner = view.nodes.find(
        (n) => n.role === 'primary' && n.slots.some(([s, e]) => slot >= s && slot <= e),
      )!.address;
      const other = nodes.find((n) => n !== owner)!;
      expect(await session.command(['SET', key, 'moved'], { node: other })).toMatchObject({
        value: 'OK',
      });
      expect(text(await session.command(['GET', key], { node: other }))).toBe('moved');
      const chunks: unknown[] = [];
      session.setTargetNode(other);
      for await (const chunk of session.execute(`get ${key}`, { executionId: `moved-${p}` })) {
        chunks.push(chunk);
      }
      const row = chunks.find((c) => (c as { type: string }).type === 'rows') as {
        data: unknown[][];
      };
      // The answer is attributed to the owner, by the address it announces.
      expect(row.data[1]![0]).toBe(owner);
    } finally {
      session.setTargetNode(undefined);
      await cleanup(session, p);
      await session.close();
    }
  });
});
