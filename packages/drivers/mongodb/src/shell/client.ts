import {
  QuerybaraError,
  fromErrorData,
  newId,
  type ErrorData,
  type ResolvedProfile,
} from '@querybara/core';
import type { ShellEvent, ShellInfo, ShellPromptAnswer } from '@querybara/mongo-tools';

import type {
  HostToShell,
  ShellPolicyMessage,
  ShellPort,
  ShellRequest,
  ShellToHost,
} from './protocol';

/**
 * The connection host's side of an IntelliShell (ADR 0036): one worker thread per shell, which
 * runs mongosh on a connection of its own. This module stays light (no mongosh): the host loads
 * it for every MongoDB connection and spawns the worker only when a shell opens.
 *
 * Interrupting asks the shell to stop at its next checkpoint; a script that does not stop within
 * the grace period (an endless loop with no shell call in it) has its thread terminated, and a
 * new one opens in the same database: its variables and open results are gone, as after
 * Studio 3T's "Restart shell".
 */

/** A started worker thread: its port, how to stop it, and how it tells that it stopped. */
export interface ShellWorkerHandle {
  readonly port: ShellPort;
  terminate(): Promise<void>;
  /** Called once when the thread ends on its own (a crash, an out-of-memory). */
  onExit(listener: (error?: Error) => void): void;
}

export type ShellWorkerSpawner = () => ShellWorkerHandle;

export interface ShellClientOptions {
  readonly spawn: ShellWorkerSpawner;
  readonly resolved: ResolvedProfile;
  readonly database: string | undefined;
  readonly policy: ShellPolicyMessage;
  readonly pageSize?: number;
  /** How long an interrupted script may take to stop before its thread restarts; 3 s. */
  readonly interruptGraceMs?: number;
}

const INTERRUPT_GRACE_MS = 3000;

/** Events of one run, handed from the port's listener to the run's async iterator. */
class EventQueue {
  readonly #items: ShellEvent[] = [];
  #wake: (() => void) | undefined;
  #closed = false;

  push(event: ShellEvent): void {
    if (this.#closed) return;
    this.#items.push(event);
    if (event.type === 'end') this.#closed = true;
    this.#wake?.();
  }

  get ended(): boolean {
    return this.#closed;
  }

  async *drain(): AsyncGenerator<ShellEvent> {
    for (;;) {
      const next = this.#items.shift();
      if (next) {
        yield next;
        if (next.type === 'end') return;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
      this.#wake = undefined;
    }
  }
}

export class ShellClient {
  readonly #options: ShellClientOptions;
  #worker: ShellWorkerHandle | undefined;
  #info: ShellInfo | undefined;
  readonly #requests = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void }
  >();
  readonly #runs = new Map<string, EventQueue>();
  #opening:
    { resolve: (info: ShellInfo) => void; reject: (error: QuerybaraError) => void } | undefined;
  #closed = false;

  private constructor(options: ShellClientOptions) {
    this.#options = options;
  }

  /** Starts the worker and connects it; rejects with the connection's error. */
  static async start(options: ShellClientOptions): Promise<ShellClient> {
    const client = new ShellClient(options);
    await client.#open(options.database);
    return client;
  }

  get info(): ShellInfo {
    if (!this.#info)
      throw new QuerybaraError({ code: 'CONNECTION_FAILED', message: 'Not connected' });
    return this.#info;
  }

  get running(): boolean {
    return [...this.#runs.values()].some((run) => !run.ended);
  }

  async #open(database: string | undefined): Promise<ShellInfo> {
    const worker = this.#options.spawn();
    this.#worker = worker;
    worker.port.on('message', (data) => {
      if (this.#worker === worker) this.#receive(data as ShellToHost);
    });
    worker.onExit((error) => {
      if (this.#worker === worker) this.#lost(error);
    });
    const opened = new Promise<ShellInfo>((resolve, reject) => {
      this.#opening = { resolve, reject };
    });
    this.#post({
      type: 'open',
      resolved: this.#options.resolved,
      database,
      policy: this.#options.policy,
      ...(this.#options.pageSize !== undefined ? { pageSize: this.#options.pageSize } : {}),
    });
    try {
      const info = await opened;
      this.#info = info;
      return info;
    } catch (error) {
      this.#worker = undefined;
      await worker.terminate().catch(() => undefined);
      throw error;
    }
  }

  #post(message: HostToShell): void {
    this.#worker?.port.postMessage(message);
  }

  #receive(message: ShellToHost): void {
    switch (message.type) {
      case 'opened':
        this.#opening?.resolve(message.info);
        this.#opening = undefined;
        return;
      case 'failed':
        this.#opening?.reject(fromErrorData(message.error));
        this.#opening = undefined;
        return;
      case 'event': {
        const event = message.event;
        if (event.type === 'database' && this.#info) {
          this.#info = { ...this.#info, database: event.name };
        }
        this.#runs.get(message.runId)?.push(event);
        return;
      }
      case 'response': {
        const pending = this.#requests.get(message.requestId);
        this.#requests.delete(message.requestId);
        if (message.error) pending?.reject(fromErrorData(message.error));
        else pending?.resolve(message.result);
        return;
      }
      case 'closed':
        return;
    }
  }

  /** The thread ended on its own: everything waiting on it fails. */
  #lost(error?: Error): void {
    const reason: ErrorData = {
      code: 'CONNECTION_FAILED',
      message: `The shell stopped${error ? `: ${error.message}` : ''}`,
      hint: 'Run the script again to start a new shell.',
    };
    this.#worker = undefined;
    this.#opening?.reject(fromErrorData(reason));
    this.#opening = undefined;
    this.#failAll(reason);
  }

  #failAll(reason: ErrorData): void {
    for (const pending of this.#requests.values()) pending.reject(fromErrorData(reason));
    this.#requests.clear();
    for (const run of this.#runs.values()) {
      run.push({ type: 'error', message: reason.message });
      run.push({ type: 'end', status: 'error', durationMs: 0, ran: 0 });
    }
    this.#runs.clear();
  }

  async #ensureWorker(): Promise<void> {
    if (this.#closed) {
      throw new QuerybaraError({ code: 'NOT_FOUND', message: 'This shell is closed' });
    }
    if (!this.#worker) await this.#open(this.#info?.database ?? this.#options.database);
  }

  /**
   * Runs a script; yields its events through `end`. Stopping the iteration early interrupts the
   * script. Prompts arrive as events and are answered with `answer`.
   */
  async *evaluate(script: string): AsyncGenerator<ShellEvent> {
    await this.#ensureWorker();
    if (this.running) {
      throw new QuerybaraError({ code: 'CONFLICT', message: 'A script is already running here' });
    }
    const runId = newId();
    const queue = new EventQueue();
    this.#runs.set(runId, queue);
    this.#post({ type: 'evaluate', runId, script });
    try {
      yield* queue.drain();
    } finally {
      if (!queue.ended) await this.interrupt();
      this.#runs.delete(runId);
    }
  }

  answer(promptId: string, answer: ShellPromptAnswer): void {
    const runId = [...this.#runs.entries()].find(([, run]) => !run.ended)?.[0];
    if (runId !== undefined) this.#post({ type: 'answer', runId, promptId, answer });
  }

  async #request<T>(call: ShellRequest): Promise<T> {
    await this.#ensureWorker();
    const requestId = newId();
    return new Promise<T>((resolve, reject) => {
      this.#requests.set(requestId, { resolve: resolve as (value: unknown) => void, reject });
      this.#post({ type: 'request', requestId, ...call });
    });
  }

  more(resultId: string, count?: number): Promise<{ documents: string[]; hasMore: boolean }> {
    return this.#request({ method: 'more', resultId, ...(count !== undefined ? { count } : {}) });
  }

  closeResult(resultId: string): Promise<void> {
    if (!this.#worker) return Promise.resolve();
    return this.#request({ method: 'closeResult', resultId });
  }

  complete(text: string): Promise<string[]> {
    return this.#request({ method: 'complete', text });
  }

  async useDatabase(database: string): Promise<string> {
    const name = await this.#request<string>({ method: 'useDatabase', database });
    if (this.#info) this.#info = { ...this.#info, database: name };
    return name;
  }

  /**
   * Stops the running script: at the shell's next checkpoint, or by restarting the shell's
   * thread when it does not stop within the grace period.
   */
  async interrupt(): Promise<void> {
    const running = [...this.#runs.values()].filter((run) => !run.ended);
    if (running.length === 0 || !this.#worker) return;
    this.#post({ type: 'interrupt' });
    const deadline = Date.now() + (this.#options.interruptGraceMs ?? INTERRUPT_GRACE_MS);
    while (Date.now() < deadline && running.some((run) => !run.ended)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (running.every((run) => run.ended)) return;
    await this.restart(
      'The script did not stop, so the shell was restarted: its variables and open results are gone',
    );
  }

  /** Terminates the shell's thread and opens a new one in the same database. */
  async restart(
    reason = 'The shell was restarted: its variables and open results are gone',
  ): Promise<void> {
    const worker = this.#worker;
    this.#worker = undefined;
    for (const run of this.#runs.values()) {
      run.push({ type: 'print', text: reason, stream: 'error' });
      run.push({ type: 'end', status: 'cancelled', durationMs: 0, ran: 0 });
    }
    this.#runs.clear();
    const lost: ErrorData = { code: 'CANCELLED', message: reason };
    for (const pending of this.#requests.values()) pending.reject(fromErrorData(lost));
    this.#requests.clear();
    await worker?.terminate().catch(() => undefined);
    if (!this.#closed) await this.#open(this.#info?.database ?? this.#options.database);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const worker = this.#worker;
    this.#worker = undefined;
    this.#failAll({ code: 'CANCELLED', message: 'The shell was closed' });
    if (!worker) return;
    const closed = new Promise<void>((resolve) => {
      worker.port.on('message', (data) => {
        if ((data as ShellToHost).type === 'closed') resolve();
      });
      setTimeout(resolve, 2000);
    });
    worker.port.postMessage({ type: 'close' } satisfies HostToShell);
    await closed;
    await worker.terminate().catch(() => undefined);
  }
}
