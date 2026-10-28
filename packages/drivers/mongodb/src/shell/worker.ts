import { QuerybaraError, newId, toErrorData } from '@querybara/core';
import type { ShellPromptAnswer } from '@querybara/mongo-tools';
import evaluatorPackage from '@mongosh/shell-evaluator/package.json';

import { connectMongoClient } from '../session';
import type { HostToShell, ShellPort, ShellRequest, ShellToHost } from './protocol';
import { ShellRuntime } from './runtime';

/**
 * The worker thread side of an IntelliShell (ADR 0036): connects with the profile the host hands
 * over, runs one ShellRuntime, and answers the host's messages. A script that never yields (an
 * endless loop) blocks only this thread; the host then terminates it and starts another.
 */

/** The version of mongosh's shell packages the app embeds. */
export const MONGOSH_VERSION: string = evaluatorPackage.version;

export function serveShellWorker(port: ShellPort): void {
  let runtime: ShellRuntime | undefined;
  /** Questions of the running script waiting for the page. */
  const prompts = new Map<string, (answer: ShellPromptAnswer) => void>();
  const send = (message: ShellToHost): void => port.postMessage(message);

  const open = async (message: Extract<HostToShell, { type: 'open' }>): Promise<void> => {
    try {
      const { client, plan } = await connectMongoClient(
        message.resolved,
        message.oidcState !== undefined ? { oidcState: message.oidcState } : {},
      );
      const build = await client.db('admin').command({ buildInfo: 1 });
      runtime = await ShellRuntime.open({
        client,
        database: message.database ?? plan.defaultDatabase,
        policy: message.policy,
        ...(message.pageSize !== undefined ? { pageSize: message.pageSize } : {}),
      });
      send({
        type: 'opened',
        info: {
          database: runtime.database,
          mongoshVersion: MONGOSH_VERSION,
          serverVersion: String(build['version'] ?? ''),
        },
      });
    } catch (error) {
      send({ type: 'failed', error: toErrorData(error) });
    }
  };

  const evaluate = async (runId: string, script: string): Promise<void> => {
    const shell = opened();
    await shell.evaluate(script, {
      emit: (event) => send({ type: 'event', runId, event }),
      ask: (prompt) =>
        new Promise<ShellPromptAnswer>((resolve) => {
          const promptId = newId();
          prompts.set(promptId, resolve);
          send({ type: 'event', runId, event: { type: 'prompt', promptId, ...prompt } });
        }),
    });
  };

  const opened = (): ShellRuntime => {
    if (!runtime) throw new QuerybaraError({ code: 'CONNECTION_FAILED', message: 'Not connected' });
    return runtime;
  };

  const request = async (message: ShellRequest): Promise<unknown> => {
    const shell = opened();
    switch (message.method) {
      case 'more':
        return shell.more(message.resultId, message.count);
      case 'closeResult':
        return shell.closeResult(message.resultId);
      case 'complete':
        return shell.complete(message.text);
      case 'useDatabase':
        shell.useDatabase(message.database);
        return shell.database;
    }
  };

  const close = async (): Promise<void> => {
    for (const resolve of prompts.values()) resolve({ kind: 'deny' });
    prompts.clear();
    await runtime?.interrupt().catch(() => undefined);
    await runtime?.close().catch(() => undefined);
    runtime = undefined;
    send({ type: 'closed' });
    port.close();
  };

  port.on('message', (data) => {
    const message = data as HostToShell;
    switch (message.type) {
      case 'open':
        void open(message);
        return;
      case 'evaluate':
        evaluate(message.runId, message.script).catch((error: unknown) => {
          const { message: text } = toErrorData(error);
          send({ type: 'event', runId: message.runId, event: { type: 'error', message: text } });
          send({
            type: 'event',
            runId: message.runId,
            event: { type: 'end', status: 'error', durationMs: 0, ran: 0 },
          });
        });
        return;
      case 'answer': {
        const resolve = prompts.get(message.promptId);
        prompts.delete(message.promptId);
        resolve?.(message.answer);
        return;
      }
      case 'interrupt':
        for (const resolve of prompts.values()) resolve({ kind: 'deny' });
        prompts.clear();
        void runtime?.interrupt();
        return;
      case 'request': {
        const { type: _type, requestId, ...call } = message;
        request(call)
          .then((result) => send({ type: 'response', requestId, result }))
          .catch((error: unknown) =>
            send({ type: 'response', requestId, error: toErrorData(error) }),
          );
        return;
      }
      case 'close':
        void close();
        return;
    }
  });
}
