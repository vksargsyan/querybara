import {
  QuerybaraError,
  newId,
  requiresWriteConfirmation,
  type ConnectionProfile,
  type ResolvedProfile,
} from '@querybara/core';
import type { ShellClient, ShellPolicyMessage } from '@querybara/driver-mongodb';
import type { HandlersOf, mongoHostContractShape } from '@querybara/ipc';
import { nodeRouteOf } from '@querybara/tunnel';

/**
 * The connection host's IntelliShells (ADR 0036): `mongo.shell.*`. Each shell is a ShellClient,
 * a mongosh in a worker thread with a connection of its own through the profile's tunnel; the
 * host keeps them by id, per port, as it keeps sessions, and closes a port's shells with it.
 * The write rules go to the worker with the profile; it applies them to every write a script
 * makes and asks the page through `prompt` events.
 */

type ShellHandlers = HandlersOf<typeof mongoHostContractShape>['shell'];

/** A started shell and how to close it (and release its tunnel). */
export interface OpenedShell {
  readonly client: ShellClient;
  readonly close: () => Promise<void>;
}

/** Starts a shell in `database` (the profile's default database when undefined). */
export type ShellOpener = (database: string | undefined) => Promise<OpenedShell>;

/** The write rules of a profile, as the shell applies them. */
export function shellPolicy(profile: ConnectionProfile): ShellPolicyMessage {
  return {
    connectionName: profile.name,
    readOnly: profile.presentation.readOnly,
    confirmWrites: requiresWriteConfirmation(profile),
  };
}

/**
 * A profile the worker thread can receive: a node route keeps only its SOCKS5 endpoint, the one
 * part the MongoDB driver uses (its forwarding methods cannot cross to another thread).
 */
export function shellProfile(resolved: ResolvedProfile): ResolvedProfile {
  const route = nodeRouteOf(resolved);
  if (!route) return resolved;
  return { ...resolved, nodeRoute: { socks5: route.socks5 } } as ResolvedProfile;
}

export class MongoShells {
  readonly #open: ShellOpener | undefined;
  readonly #shells = new Map<string, { readonly opened: OpenedShell; readonly owner: symbol }>();

  constructor(open: ShellOpener | undefined) {
    this.#open = open;
  }

  #client(shellId: string): ShellClient {
    const entry = this.#shells.get(shellId);
    if (!entry) {
      throw new QuerybaraError({
        code: 'NOT_FOUND',
        message: 'This shell is closed',
        hint: 'Open IntelliShell again.',
      });
    }
    return entry.opened.client;
  }

  async #close(shellId: string): Promise<void> {
    const entry = this.#shells.get(shellId);
    this.#shells.delete(shellId);
    await entry?.opened.close();
  }

  /** Closes the shells a port opened (its window closed or reloaded). */
  async closeOwnedBy(owner: symbol): Promise<void> {
    const owned = [...this.#shells].filter(([, entry]) => entry.owner === owner);
    await Promise.allSettled(owned.map(([id]) => this.#close(id)));
  }

  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.#shells.keys()].map((id) => this.#close(id)));
  }

  get size(): number {
    return this.#shells.size;
  }

  handlers(owner: symbol): ShellHandlers {
    return {
      open: async ({ database }) => {
        if (!this.#open) {
          throw new QuerybaraError({
            code: 'NOT_SUPPORTED',
            message: 'IntelliShell needs a MongoDB connection',
          });
        }
        const opened = await this.#open(database);
        const shellId = newId();
        this.#shells.set(shellId, { opened, owner });
        return { shellId, info: opened.client.info };
      },
      evaluate: ({ shellId, script }) => this.#client(shellId).evaluate(script),
      answer: ({ shellId, promptId, answer }) => {
        this.#client(shellId).answer(promptId, answer);
      },
      interrupt: ({ shellId }) => this.#client(shellId).interrupt(),
      restart: async ({ shellId }) => {
        const client = this.#client(shellId);
        await client.restart();
        return client.info;
      },
      more: ({ shellId, resultId, count }) => this.#client(shellId).more(resultId, count),
      closeResult: ({ shellId, resultId }) => this.#client(shellId).closeResult(resultId),
      complete: async ({ shellId, text }) => ({
        completions: await this.#client(shellId).complete(text),
      }),
      useDatabase: async ({ shellId, database }) => {
        const client = this.#client(shellId);
        await client.useDatabase(database);
        return client.info;
      },
      close: ({ shellId }) => this.#close(shellId),
    };
  }
}
