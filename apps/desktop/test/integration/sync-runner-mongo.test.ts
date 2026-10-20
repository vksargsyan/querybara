import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  connectionProfileSchema,
  newId,
  type ConnectionProfileInput,
  type ResolvedProfile,
  type Session,
} from '@querybara/core';
import type { DataScriptPreview, StructureScript } from '@querybara/ipc';
import { parseConnectionUri } from '@querybara/storage';
import { runMongoCommand } from '@querybara/sync';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadAdapter } from '../../src/connection-host/adapters';
import { JobRunner } from '../../src/job-runner/runner';
import type { RunnerRequest, RunnerToMain } from '../../src/shared/job-protocol';
import {
  dataJobResultSchema,
  structureJobResultSchema,
  type SyncJobSpec,
} from '../../src/shared/sync-jobs';
import { rowPageFile, rowPageFileSchema } from '../../src/shared/sync-spool';

/**
 * MongoDB structure and data sync in the job runner against the real replica set (spec §13):
 * two databases are compared, the commands applied and the re-compare is clean; the data
 * compare spools rows for the grid and batched commands that apply and compare clean, and a
 * command the target refuses stops the apply with what stays applied.
 */

const MONGO_URL = process.env['QUERYBARA_TEST_MONGODB_URL'];

function profile(
  database: string,
  presentation: ConnectionProfileInput['presentation'] = {},
): ResolvedProfile {
  const url = new URL(MONGO_URL!);
  url.searchParams.set('tls', 'false');
  const parsed = parseConnectionUri(url.toString());
  const now = new Date().toISOString();
  const resolved = connectionProfileSchema.parse({
    ...parsed.profile,
    id: newId(),
    presentation,
    createdAt: now,
    updatedAt: now,
    options: { ...parsed.profile.options, defaultDatabase: database },
  });
  const ref = resolved.auth.method === 'password' ? resolved.auth.password : undefined;
  return {
    profile: resolved,
    secrets: ref && parsed.password !== undefined ? { [ref.id]: parsed.password } : {},
  };
}

describe.skipIf(!MONGO_URL)('MongoDB sync in the job runner', () => {
  const suffix = randomBytes(4).toString('hex');
  const sourceDb = `querybara_msy_src_${suffix}`;
  const targetDb = `querybara_msy_tgt_${suffix}`;
  const posted: RunnerToMain[] = [];
  const sessions: Session[] = [];
  let source: Session;
  let target: Session;
  let work = '';
  const runner = new JobRunner({
    post: (message) => posted.push(message),
    connect: async (resolved) => {
      const session = await (await loadAdapter(resolved.profile.engine)).connect(resolved);
      return { session, close: () => session.close() };
    },
  });

  async function job(
    spec: SyncJobSpec,
    resolved: ResolvedProfile,
    from?: ResolvedProfile,
  ): Promise<Extract<RunnerToMain, { type: 'done' }>> {
    const jobId = newId();
    runner.handle({ type: 'start', jobId, job: spec, resolved, ...(from ? { source: from } : {}) });
    for (;;) {
      const done = posted.find((m) => m.type === 'done' && m.jobId === jobId);
      if (done?.type === 'done') return done;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async function request<T>(input: RunnerRequest): Promise<T> {
    const requestId = newId();
    runner.handle({ type: 'request', requestId, request: input });
    for (;;) {
      const response = posted.find((m) => m.type === 'response' && m.requestId === requestId);
      if (response?.type === 'response') {
        if (response.error) throw new Error(response.error.message);
        return response.result as T;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  const run = async (session: Session, commands: string[]): Promise<void> => {
    for (const command of commands) await runMongoCommand(session, command);
  };

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'querybara-msync-it-'));
    const adapter = await loadAdapter('mongodb');
    source = await adapter.connect(profile(sourceDb));
    target = await adapter.connect(profile(targetDb));
    sessions.push(source, target);
    await run(source, [
      `{ create: 'customers', validator: { $jsonSchema: { required: ['email'] } } }`,
      `{ createIndexes: 'customers', indexes: [{ key: { email: 1 }, name: 'email_1', unique: true }] }`,
      `{ create: 'orders' }`,
      `{ create: 'vip', viewOn: 'customers', pipeline: [{ $match: { vip: true } }] }`,
      `{ insert: 'customers', documents: [
          { _id: 1, email: 'a@x', vip: true },
          { _id: 2, email: 'b@x', n: NumberLong(7) },
          { _id: 3, email: 'c@x' }
        ] }`,
    ]);
    await run(target, [
      `{ create: 'customers' }`,
      `{ createIndexes: 'customers', indexes: [{ key: { legacy: 1 }, name: 'legacy_1' }] }`,
      `{ create: 'archive' }`,
      `{ insert: 'customers', documents: [
          { _id: 2, email: 'b@x', n: 7 },
          { _id: 3, email: 'c@x' },
          { _id: 4, email: 'd@x' }
        ] }`,
    ]);
  });

  afterAll(async () => {
    const admin = target as unknown as { dropDatabase(name: string): Promise<void> };
    for (const name of [sourceDb, targetDb]) await admin.dropDatabase(name).catch(() => undefined);
    for (const session of sessions) await session.close();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it('compares the structure, applies every command and compares clean', async () => {
    const compare = () =>
      job(
        {
          kind: 'structure-compare',
          profileId: 'target',
          sourceProfileId: 'source',
          source: { database: sourceDb },
          target: { database: targetDb },
          options: {},
        },
        profile(targetDb),
        profile(sourceDb),
      );
    const done = await compare();
    expect(done.error).toBeUndefined();
    const result = structureJobResultSchema.parse(done.result);
    expect(result.diff.dialect).toBe('mongodb');
    const ids = result.diff.operations.map((op) => op.id);
    expect(ids.sort()).toEqual([
      'collection:archive:drop',
      'collection:customers:alter',
      'collection:orders:create',
      'index:customers.email_1:create',
      'index:customers.legacy_1:drop',
      'view:vip:create',
    ]);
    const script = await request<StructureScript>({
      kind: 'sync-script',
      input: { diff: result.diff, selected: ids },
    });
    expect(script.text).toContain(`db = db.getSiblingDB("${targetDb}");`);

    const applied = await job(
      {
        kind: 'structure-apply',
        profileId: 'target',
        target: { database: targetDb },
        diff: result.diff,
        selected: ids,
        sourceSnapshot: result.sourceSnapshot!,
        scriptSha256: script.sha256,
        confirmed: false,
      },
      profile(targetDb),
    );
    expect(applied.error).toBeUndefined();
    expect(applied.summary).toMatchObject({ status: 'completed', failed: 0 });
    const after = structureJobResultSchema.parse(applied.result);
    expect(after.applied?.unconverged).toEqual([]);
    expect(after.diff.operations).toEqual([]);
  });

  it('compares documents, spools grid rows and commands, applies them and compares clean', async () => {
    const compare = (dir: string) =>
      job(
        {
          kind: 'data-compare',
          profileId: 'target',
          sourceProfileId: 'source',
          source: { database: sourceDb },
          target: { database: targetDb },
          options: { actions: { insert: true, update: true, delete: true } },
          spoolDir: dir,
        },
        profile(targetDb),
        profile(sourceDb),
      );
    const spoolDir = mkdtempSync(join(work, 'spool-'));
    const done = await compare(spoolDir);
    expect(done.error).toBeUndefined();
    const result = dataJobResultSchema.parse(done.result);
    const customers = result.tables.find((t) => t.name === 'customers')!;
    expect(customers).toMatchObject({
      keyColumns: ['_id'],
      columns: ['_id', 'fields', 'values'],
      counts: { inserts: 1, updates: 1, deletes: 1, equal: 1 },
      stored: { insert: 1, update: 1, delete: 1 },
      statements: { insert: 1, update: 1, delete: 1 },
    });
    const update = rowPageFileSchema.parse(
      JSON.parse(readFileSync(join(spoolDir, rowPageFile(customers.index, 'update', 0)), 'utf8')),
    )[0]!;
    expect(update).toEqual({
      action: 'update',
      key: ['2'],
      source: ['2', 'n', "{ n: Long('7') }"],
      target: ['2', 'n', '{ n: 7 }'],
      changed: ['values'],
    });

    const preview = await request<DataScriptPreview>({
      kind: 'sync-data-script',
      input: {
        spoolDir,
        tables: [customers.index],
        actions: { insert: true, update: true, delete: true },
      },
    });
    expect(preview.statements.map((s) => /^\{\s*(\w+)/.exec(s)?.[1])).toEqual([
      'delete',
      'update',
      'insert',
    ]);

    const scriptPath = join(work, 'sync.js');
    await request({
      kind: 'sync-data-script',
      input: {
        spoolDir,
        tables: [customers.index],
        actions: { insert: true, update: true, delete: true },
        path: scriptPath,
      },
    });
    const text = readFileSync(scriptPath, 'utf8');
    expect(text).toContain(`db = db.getSiblingDB("${targetDb}");`);
    expect(text).toContain("sync({ delete: 'customers'");
    expect(text).toContain('function sync(command) {');

    // Only the update ticked in the row grid: the insert and the delete stay.
    const partial = await job(
      {
        kind: 'data-apply',
        profileId: 'target',
        target: { database: targetDb },
        spoolDir,
        tables: [customers.index],
        actions: { insert: true, update: true, delete: true },
        rows: [
          { table: customers.index, action: 'insert', mode: 'only', rows: [] },
          { table: customers.index, action: 'delete', mode: 'except', rows: [0] },
        ],
        confirmed: false,
      },
      profile(targetDb),
    );
    expect(partial.error).toBeUndefined();
    expect(partial.summary).toMatchObject({ status: 'completed', rowsAffected: 1 });
    const restDir = mkdtempSync(join(work, 'spool-'));
    const rest = dataJobResultSchema.parse((await compare(restDir)).result);
    const restCustomers = rest.tables.find((t) => t.name === 'customers')!;
    expect(restCustomers.counts).toMatchObject({ inserts: 1, updates: 0, deletes: 1, equal: 2 });

    const applied = await job(
      {
        kind: 'data-apply',
        profileId: 'target',
        target: { database: targetDb },
        spoolDir: restDir,
        tables: [restCustomers.index],
        actions: { insert: true, update: true, delete: true },
        confirmed: false,
      },
      profile(targetDb),
    );
    expect(applied.error).toBeUndefined();
    expect(applied.summary).toMatchObject({ status: 'completed', rowsAffected: 2 });

    const again = dataJobResultSchema.parse(
      (await compare(mkdtempSync(join(work, 'spool-')))).result,
    );
    expect(again.tables.find((t) => t.name === 'customers')!.counts).toMatchObject({
      inserts: 0,
      updates: 0,
      deletes: 0,
      equal: 3,
    });
  });

  it('stops at a command the target refuses and says what stays applied', async () => {
    // The target's unique email index (applied above) already has z@x under another _id.
    await run(source, [`{ insert: 'customers', documents: [{ _id: 10, email: 'z@x' }] }`]);
    await run(target, [`{ insert: 'customers', documents: [{ _id: 11, email: 'z@x' }] }`]);
    const spoolDir = mkdtempSync(join(work, 'spool-'));
    const done = await job(
      {
        kind: 'data-compare',
        profileId: 'target',
        sourceProfileId: 'source',
        source: { database: sourceDb },
        target: { database: targetDb },
        options: { actions: { insert: true, update: true, delete: true } },
        spoolDir,
      },
      profile(targetDb),
      profile(sourceDb),
    );
    const customers = dataJobResultSchema
      .parse(done.result)
      .tables.find((t) => t.name === 'customers')!;
    expect(customers.counts).toMatchObject({ inserts: 1, deletes: 1 });
    const failed = await job(
      {
        kind: 'data-apply',
        profileId: 'target',
        target: { database: targetDb },
        spoolDir,
        tables: [customers.index],
        actions: { insert: true, update: false, delete: false },
        confirmed: false,
      },
      profile(targetDb),
    );
    expect(failed.summary).toMatchObject({ status: 'failed', failed: 1 });
    expect(failed.errors[0]?.message).toMatch(/duplicate key/);
    expect(failed.summary?.outcome).toMatch(/Nothing was applied/);
  });
});
