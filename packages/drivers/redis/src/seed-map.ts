import type { ConnectionOptions } from 'node:tls';

import type { HostPort } from '@querybara/core';
import type { NetworkTarget } from '@querybara/driver-sql-base';

import type { RedisConnectionPlan } from './config';
import { addressText, probeClient, type Mapped } from './routing';

/**
 * Cluster nodes behind NAT (Docker, Kubernetes NodePorts, a load balancer port per node)
 * announce addresses only reachable inside their network, in CLUSTER SLOTS and in MOVED and ASK.
 * With the profile's `mapNodesToSeeds`, every seed is asked which node it is (the "myself" line
 * of CLUSTER NODES) before connecting, and the addresses that node announces are mapped back to
 * the seed, so ioredis's NAT map reaches each node where the profile says it is. Asking on every
 * connect keeps the mapping right after a node moves (a pod rescheduled with a new IP); nodes no
 * seed answers as are reached as announced.
 */
export class SeedMap {
  /** "host:port" a node connection dials → the address that node announces (`addressText`). */
  private readonly dialed = new Map<string, string>();

  private constructor(
    /** Announced "host:port" (as ioredis keys nodes) → the seed answering as that node. */
    private readonly bySeed: ReadonlyMap<string, HostPort>,
  ) {}

  /**
   * Asks every seed, in parallel, which node it is. `dial` are the targets to connect to (the
   * seeds, or their forwards behind a tunnel), index for index with `plan.seeds`; a seed that
   * does not answer is left out (connecting reports it if it matters).
   */
  static async probe(
    plan: RedisConnectionPlan,
    dial: readonly NetworkTarget[],
    tlsFor: (target: Extract<NetworkTarget, { kind: 'tcp' }>) => ConnectionOptions | undefined,
  ): Promise<SeedMap> {
    const answers = await Promise.all(
      plan.seeds.map(async (seed, i) => {
        const target = dial[i];
        if (seed.kind !== 'tcp' || target?.kind !== 'tcp') return [];
        const probe = probeClient(plan, target, tlsFor(target));
        probe.on('error', () => undefined);
        try {
          await probe.connect();
          const reply = await probe.call('cluster', 'nodes');
          const announced = announcedByMyself(String(reply));
          return announced.map((a) => [nodeKey(a), { host: seed.host, port: seed.port }] as const);
        } catch {
          return [];
        } finally {
          probe.disconnect();
        }
      }),
    );
    const bySeed = new Map<string, HostPort>();
    for (const [key, seed] of answers.flat()) if (!bySeed.has(key)) bySeed.set(key, seed);
    return new SeedMap(bySeed);
  }

  /** How many announced addresses map to a seed. */
  get size(): number {
    return this.bySeed.size;
  }

  /**
   * ioredis's NAT map: an announced address to the seed answering as that node, through `next`
   * (the tunnel's NAT map) when there is one. Other addresses are left as announced.
   */
  natMap(next?: (key: string) => Mapped): (key: string) => Mapped | null {
    return (key) => {
      const seed = this.bySeed.get(key);
      let mapped: Mapped | null;
      if (next) mapped = next(seed ? nodeKey(seed) : key);
      else mapped = seed ? { host: seed.host, port: seed.port } : null;
      if (seed && mapped) this.dialed.set(nodeKey(mapped), addressOfKey(key));
      return mapped;
    };
  }

  /** The address the node a connection dials announces, when it was mapped to a seed. */
  announcedAt(target: HostPort): string | undefined {
    return this.dialed.get(nodeKey(target));
  }
}

/** "host:port" as ioredis keys nodes: IPv6 hosts unbracketed. */
function nodeKey({ host, port }: HostPort): string {
  return `${host}:${port}`;
}

function addressOfKey(key: string): string {
  const colon = key.lastIndexOf(':');
  return addressText({ host: key.slice(0, colon), port: Number(key.slice(colon + 1)) });
}

/**
 * The addresses the answering node announces, from the "myself" line of a CLUSTER NODES reply:
 * `<id> <ip>:<port>[@<bus port>][,<hostname>[,<aux>=<value>...]] <flags> ...`. The IP and the
 * hostname both count, since CLUSTER SLOTS reports either (cluster-preferred-endpoint-type).
 */
export function announcedByMyself(reply: string): HostPort[] {
  for (const line of reply.split('\n')) {
    const fields = line.trim().split(' ');
    if (fields.length < 3 || !fields[2]!.split(',').includes('myself')) continue;
    const [address = '', hostname] = fields[1]!.split(',');
    const at = address.indexOf('@');
    const hostPort = at >= 0 ? address.slice(0, at) : address;
    const colon = hostPort.lastIndexOf(':');
    const port = Number(hostPort.slice(colon + 1));
    if (colon < 0 || !Number.isInteger(port) || port < 1 || port > 65535) return [];
    const out: HostPort[] = [];
    const ip = hostPort.slice(0, colon);
    if (ip !== '') out.push({ host: ip, port });
    if (hostname && !hostname.includes('=') && hostname !== ip) out.push({ host: hostname, port });
    return out;
  }
  return [];
}
