import { EventEmitter } from 'node:events';

import type { ResolvedProfile } from '@querybara/core';
import type { ShellEvent } from '@querybara/mongo-tools';
import { describe, expect, it } from 'vitest';

import { ShellClient, type HostToShell, type ShellToHost, type ShellWorkerHandle } from '../src';

/**
 * The host's side of an IntelliShell (ADR 0036) against a scripted worker: runs stream through
 * `end`, a script that ignores an interrupt gets its thread restarted, and a thread that dies
 * fails what waited on it.
 */

const RESOLVED = { profile: {}, secrets: {} } as unknown as ResolvedProfile;
const POLICY = { connectionName: 'Test', readOnly: false, confirmWrites: false };

/** A worker that answers like a shell, except that it ignores interrupts when `stuck`. */
class FakeWorker implements ShellWorkerHandle {
  readonly sent: HostToShell[] = [];
  readonly #bus = new EventEmitter();
  #exit: ((error?: Error) => void) | undefined;
  terminated = false;

  constructor(readonly options: { readonly stuck?: boolean; readonly database?: string } = {}) {}

  readonly port = {
    postMessage: (message: unknown): void => {
      const request = message as HostToShell;
      this.sent.push(request);
      queueMicrotask(() => this.#handle(request));
    },
    on: (_event: 'message', listener: (message: unknown) => void): unknown =>
      this.#bus.on('message', listener),
    close: (): void => undefined,
  };

  #reply(message: ShellToHost): void {
    this.#bus.emit('message', message);
  }

  #event(runId: string, event: ShellEvent): void {
    this.#reply({ type: 'event', runId, event });
  }

  #handle(request: HostToShell): void {
    switch (request.type) {
      case 'open':
        this.#reply({
          type: 'opened',
          info: {
            database: request.database ?? this.options.database ?? 'test',
            mongoshVersion: '5.9.5',
            serverVersion: '8.0.0',
          },
        });
        return;
      case 'evaluate':
        this.#event(request.runId, { type: 'statement', index: 0, start: 0, end: 1, line: 1 });
        if (this.options.stuck) return;
        this.#event(request.runId, { type: 'database', name: 'shop' });
        this.#event(request.runId, { type: 'end', status: 'success', durationMs: 1, ran: 1 });
        return;
      case 'request':
        this.#reply({ type: 'response', requestId: request.requestId, result: ['db.orders'] });
        return;
      case 'close':
        this.#reply({ type: 'closed' });
        return;
      default:
        return;
    }
  }

  async terminate(): Promise<void> {
    this.terminated = true;
  }

  onExit(listener: (error?: Error) => void): void {
    this.#exit = listener;
  }

  crash(): void {
    this.#exit?.(new Error('out of memory'));
  }
}

async function collect(events: AsyncIterable<ShellEvent>): Promise<ShellEvent[]> {
  const out: ShellEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('ShellClient', () => {
  it('opens the worker, streams a run through end, and follows the database', async () => {
    const worker = new FakeWorker();
    const client = await ShellClient.start({
      spawn: () => worker,
      resolved: RESOLVED,
      database: 'admin',
      policy: POLICY,
    });
    expect(client.info).toEqual({
      database: 'admin',
      mongoshVersion: '5.9.5',
      serverVersion: '8.0.0',
    });
    const events = await collect(client.evaluate('use shop'));
    expect(events.map((e) => e.type)).toEqual(['statement', 'database', 'end']);
    expect(client.info.database).toBe('shop');
    expect(await client.complete('db.or')).toEqual(['db.orders']);
    await client.close();
    expect(worker.sent.at(-1)).toEqual({ type: 'close' });
    expect(worker.terminated).toBe(true);
  });

  it('restarts a thread that ignores an interrupt, in the same database', async () => {
    const workers: FakeWorker[] = [];
    const client = await ShellClient.start({
      spawn: () => {
        const worker = new FakeWorker({ stuck: workers.length === 0 });
        workers.push(worker);
        return worker;
      },
      resolved: RESOLVED,
      database: 'shop',
      policy: POLICY,
      interruptGraceMs: 50,
    });
    const run = collect(client.evaluate('while (true) {}'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await client.interrupt();
    const events = await run;
    expect(events.at(-1)).toMatchObject({ type: 'end', status: 'cancelled' });
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'print', text: expect.stringMatching(/restarted/) }),
    );
    expect(workers).toHaveLength(2);
    expect(workers[0]!.terminated).toBe(true);
    expect(workers[0]!.sent.map((m) => m.type)).toContain('interrupt');
    expect(workers[1]!.sent[0]).toMatchObject({ type: 'open', database: 'shop' });
    await client.close();
  });

  it('fails what waited on a thread that died, and starts a new one on the next run', async () => {
    const workers: FakeWorker[] = [];
    const client = await ShellClient.start({
      spawn: () => {
        const worker = new FakeWorker({ stuck: workers.length === 0 });
        workers.push(worker);
        return worker;
      },
      resolved: RESOLVED,
      database: undefined,
      policy: POLICY,
    });
    const run = collect(client.evaluate('heavy()'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    workers[0]!.crash();
    const events = await run;
    expect(events.slice(-2)).toEqual([
      { type: 'error', message: 'The shell stopped: out of memory' },
      { type: 'end', status: 'error', durationMs: 0, ran: 0 },
    ]);
    const next = await collect(client.evaluate('1'));
    expect(next.at(-1)).toMatchObject({ type: 'end', status: 'success' });
    expect(workers).toHaveLength(2);
    await client.close();
  });
});
