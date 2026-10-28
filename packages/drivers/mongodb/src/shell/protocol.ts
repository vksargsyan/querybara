import type { ErrorData, ResolvedProfile } from '@querybara/core';
import type { ShellEvent, ShellInfo, ShellPromptAnswer } from '@querybara/mongo-tools';

/**
 * Messages between a connection host and the worker thread that runs one IntelliShell
 * (ADR 0036). Both ends are in the same process and trust each other; the page's input was
 * validated by the host's contract before it gets here.
 */

/** The write rules a shell applies (see ShellWritePolicy). */
export interface ShellPolicyMessage {
  readonly connectionName: string;
  readonly readOnly: boolean;
  readonly confirmWrites: boolean;
}

/** A shell request answered by one response. */
export type ShellRequest =
  | { readonly method: 'more'; readonly resultId: string; readonly count?: number }
  | { readonly method: 'closeResult'; readonly resultId: string }
  | { readonly method: 'complete'; readonly text: string }
  | { readonly method: 'useDatabase'; readonly database: string };

export type HostToShell =
  | {
      readonly type: 'open';
      /**
       * The profile as the worker connects with it: through the host's tunnel already (an
       * endpoint override, or the SOCKS5 endpoint of `nodeRoute`), secrets resolved.
       */
      readonly resolved: ResolvedProfile;
      readonly database: string | undefined;
      readonly policy: ShellPolicyMessage;
      readonly pageSize?: number;
    }
  | { readonly type: 'evaluate'; readonly runId: string; readonly script: string }
  | {
      readonly type: 'answer';
      readonly runId: string;
      readonly promptId: string;
      readonly answer: ShellPromptAnswer;
    }
  | { readonly type: 'interrupt' }
  | ({ readonly type: 'request'; readonly requestId: string } & ShellRequest)
  | { readonly type: 'close' };

export type ShellToHost =
  | { readonly type: 'opened'; readonly info: ShellInfo }
  | { readonly type: 'failed'; readonly error: ErrorData }
  | { readonly type: 'event'; readonly runId: string; readonly event: ShellEvent }
  | {
      readonly type: 'response';
      readonly requestId: string;
      readonly result?: unknown;
      readonly error?: ErrorData;
    }
  | { readonly type: 'closed' };

/** The end of a MessagePort or a worker_threads port both sides talk through. */
export interface ShellPort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  close(): void;
}
