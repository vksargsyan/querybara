import { parentPort } from 'node:worker_threads';

import { serveShellWorker } from '@querybara/driver-mongodb/shell';

/**
 * The worker thread of one IntelliShell (ADR 0036), started by its connection host: mongosh and
 * a MongoDB connection of its own, so a script that never yields blocks only this thread. Built
 * as its own entry (out/main/mongo-shell.cjs); nothing else loads mongosh.
 */
if (parentPort) serveShellWorker(parentPort);
