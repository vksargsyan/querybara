import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

import { QuerybaraError, toErrorData, type ResolvedProfile } from '@querybara/core';
import type { ShellWorkerHandle } from '@querybara/driver-mongodb';
import { fromElectronPort } from '@querybara/ipc';
import {
  TransportManager,
  checkConnectionThroughTransport,
  connectThroughTransport,
  tunnelledProfile,
} from '@querybara/tunnel';

import { mainToHostSchema, type HostRequest, type HostToMain } from '../shared/host-protocol';
import { loadAdapter } from './adapters';
import { ConnectionHost } from './host';
import { HostKeyBridge } from './host-keys';
import { shellPolicy, shellProfile, type OpenedShell } from './mongo-shell';

/**
 * Connection host entry (spec §3): an Electron utilityProcess started by main for one open
 * connection, or briefly for Test Connection. Main talks to it over the parent port with the
 * validated control protocol in shared/host-protocol; renderer RPC arrives on transferred
 * MessagePorts. Nothing here logs profile data or secrets.
 *
 * Every session and every Test Connection goes through the process's TransportManager, which
 * opens the profile's SSH tunnel or proxy (spec §4) and shares one SSH session between the
 * sessions of this connection; a replica set, Sentinel or Cluster reaches each of its nodes over
 * that session (ADR 0008). Host keys are checked by main, through the HostKeyBridge.
 */

const parent = process.parentPort;
let host: ConnectionHost | undefined;
let busy = false;

function send(message: HostToMain): void {
  parent.postMessage(message);
}

const hostKeys = new HostKeyBridge(send);
/** Requests from main in flight, to cancel them. */
const requests = new Map<string, AbortController>();

async function runRequest(requestId: string, request: HostRequest): Promise<void> {
  const controller = new AbortController();
  requests.set(requestId, controller);
  try {
    if (!host) throw new QuerybaraError({ code: 'CONNECTION_FAILED', message: 'Not connected' });
    const result = await host.request(request, {
      signal: controller.signal,
      progress: (progress) => send({ type: 'request-progress', requestId, progress }),
    });
    send({ type: 'response', requestId, result });
  } catch (error) {
    send({ type: 'response', requestId, error: toErrorData(error) });
  } finally {
    requests.delete(requestId);
  }
}
const transports = new TransportManager({ hostKeyVerifier: hostKeys.verifier });

/** Starts an IntelliShell's worker thread (the mongo-shell entry, built next to this file). */
function spawnShellWorker(): ShellWorkerHandle {
  const worker = new Worker(join(__dirname, 'mongo-shell.cjs'));
  return {
    port: {
      postMessage: (message) => worker.postMessage(message),
      on: (_event, listener) => worker.on('message', listener),
      close: () => undefined,
    },
    terminate: async () => {
      await worker.terminate();
    },
    onExit: (listener) => {
      let ended = false;
      const end = (error?: Error): void => {
        if (ended) return;
        ended = true;
        listener(error);
      };
      worker.once('error', end);
      worker.once('exit', (code) =>
        end(code === 0 ? undefined : new Error(`the thread exited with code ${code}`)),
      );
    },
  };
}

/**
 * Starts an IntelliShell on the profile: through the process's transport (the tunnel's shared
 * SSH session, or the proxy), with its own MongoDB connection in a worker thread.
 */
async function openShell(
  resolved: ResolvedProfile,
  database: string | undefined,
): Promise<OpenedShell> {
  const { ShellClient } = await import('@querybara/driver-mongodb');
  const transport = await transports.open(resolved);
  try {
    const client = await ShellClient.start({
      spawn: spawnShellWorker,
      resolved: shellProfile(transport ? tunnelledProfile(resolved, transport) : resolved),
      database,
      policy: shellPolicy(resolved.profile),
    });
    return {
      client,
      close: async () => {
        try {
          await client.close();
        } finally {
          await transport?.close();
        }
      },
    };
  } catch (error) {
    await transport?.close().catch(() => undefined);
    throw error;
  }
}

async function connect(resolved: ResolvedProfile): Promise<void> {
  try {
    const adapter = await loadAdapter(resolved.profile.engine);
    const started = new ConnectionHost(adapter, resolved, {
      open: (profile) => connectThroughTransport(adapter, profile, transports),
      // The tunnel dropped after `ready`: main restarts this host, which reopens it.
      onTransportLost: (error) => send({ type: 'failed', error: toErrorData(error) }),
      openShell: (database) => openShell(resolved, database),
    });
    const info = await started.start();
    host = started;
    send({ type: 'ready', info });
  } catch (error) {
    send({ type: 'failed', error: toErrorData(error) });
  }
}

async function check(resolved: ResolvedProfile): Promise<void> {
  try {
    const adapter = await loadAdapter(resolved.profile.engine);
    for await (const result of checkConnectionThroughTransport(adapter, resolved, transports)) {
      send({ type: 'check-step', result });
    }
    send({ type: 'check-done' });
  } catch (error) {
    send({ type: 'failed', error: toErrorData(error) });
  }
}

async function shutdown(): Promise<void> {
  await host?.shutdown();
  transports.closeAll();
  process.exit(0);
}

parent.on('message', (event) => {
  const parsed = mainToHostSchema.safeParse(event.data);
  if (!parsed.success) return;
  const message = parsed.data;
  switch (message.type) {
    case 'connect':
    case 'check':
      // One job per process: a second connect or check is a protocol error, ignored.
      if (busy) return;
      busy = true;
      void (message.type === 'connect' ? connect(message.resolved) : check(message.resolved));
      return;
    case 'attach': {
      const port = event.ports[0];
      if (!host || !port) {
        port?.close();
        return;
      }
      host.attach(fromElectronPort(port));
      return;
    }
    case 'host-key-decision':
      hostKeys.settle(message);
      return;
    case 'shutdown':
      void shutdown();
      return;
    case 'request':
      void runRequest(message.requestId, message.request);
      return;
    case 'cancel-request':
      requests.get(message.requestId)?.abort();
      return;
  }
});
