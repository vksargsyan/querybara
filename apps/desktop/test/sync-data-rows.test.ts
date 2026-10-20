import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DataRowAction } from '@querybara/ipc';
import type { RowDiff } from '@querybara/sync';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dataSyncScript } from '../src/job-runner/sync-data';
import { encodeDiff } from '../src/job-runner/sync-files';
import {
  MANIFEST_FILE,
  diffsFile,
  statementsFile,
  type SpoolManifest,
  type SpoolTable,
} from '../src/shared/sync-spool';

/**
 * Syncing only the ticked rows of a data compare (the row grid's ticks): the statements of the
 * rows the grid shows are built again from the spooled diffs, without the unticked ones, and
 * the statements of the rows past the grid's are kept (`except`) or left out (`only`).
 */

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'querybara-sync-rows-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function table(patch: Partial<SpoolTable>): SpoolTable {
  return {
    index: 0,
    name: 'items',
    source: { name: 'items' },
    target: { name: 'items' },
    keyColumns: ['id'],
    commonColumns: ['id', 'name'],
    compared: ['name'],
    columns: ['id', 'name'],
    counts: { inserts: 0, updates: 0, deletes: 0, equal: 0, sourceRows: 0, targetRows: 0 },
    checksums: false,
    ranges: 0,
    matchedRanges: 0,
    stored: { insert: 0, update: 0, delete: 0 },
    statements: { insert: 0, update: 0, delete: 0 },
    durationMs: 0,
    sourceColumns: ['id', 'name'],
    targetColumns: ['id', 'name'],
    targetKinds: { id: 'integer', name: 'string' },
    headStatements: { insert: 0, update: 0, delete: 0 },
    ...patch,
  };
}

function spool(
  dialect: SpoolManifest['dialect'],
  entry: SpoolTable,
  files: Partial<Record<DataRowAction, { diffs: RowDiff[]; statements: string[] }>>,
): void {
  const manifest: SpoolManifest = {
    version: 1,
    dialect,
    ...(dialect === 'mongodb' ? { database: 'app' } : {}),
    pageSize: 100,
    tables: [entry],
    order: [0],
    apply: { disableForeignKeyChecks: false, disableTriggers: false },
  };
  writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(manifest));
  for (const [action, file] of Object.entries(files) as [
    DataRowAction,
    { diffs: RowDiff[]; statements: string[] },
  ][]) {
    writeFileSync(
      join(dir, diffsFile(0, action)),
      file.diffs.map((d) => `${encodeDiff(d)}\n`).join(''),
    );
    writeFileSync(
      join(dir, statementsFile(0, action)),
      file.statements.map((s) => `${JSON.stringify(s)}\n`).join(''),
    );
  }
}

const insert = (id: number, name: string): RowDiff => ({
  action: 'insert',
  key: [id],
  sourceRow: [id, name],
});

describe('syncing only the ticked rows', () => {
  // Three rows shown in the grid (one INSERT), and the rows past them (one more statement).
  const sqlTable = table({
    counts: { inserts: 5, updates: 0, deletes: 1, equal: 0, sourceRows: 5, targetRows: 1 },
    stored: { insert: 3, update: 0, delete: 1 },
    statements: { insert: 2, update: 0, delete: 1 },
    headStatements: { insert: 1, update: 0, delete: 1 },
  });
  const sqlFiles = {
    insert: {
      diffs: [insert(1, 'one'), insert(2, 'two'), insert(3, "o'three")],
      statements: [
        `INSERT INTO "items" ("id", "name") VALUES\n(1, 'one'),\n(2, 'two'),\n(3, 'o''three')`,
        `INSERT INTO "items" ("id", "name") VALUES\n(4, 'four'),\n(5, 'five')`,
      ],
    },
    delete: {
      diffs: [{ action: 'delete', key: [9n], targetRow: [9n, 'nine'] } satisfies RowDiff],
      statements: [`DELETE FROM "items" WHERE "id" IN (9)`],
    },
  };
  const both = { insert: true, update: true, delete: true };

  it('leaves the unticked rows out and keeps the rows past the grid', async () => {
    spool('postgres', sqlTable, sqlFiles);
    const all = await dataSyncScript({ spoolDir: dir, tables: [0], actions: both });
    expect(all.statements).toEqual([
      'BEGIN',
      sqlFiles.delete.statements[0],
      'COMMIT',
      'BEGIN',
      ...sqlFiles.insert.statements,
      'COMMIT',
    ]);
    const some = await dataSyncScript({
      spoolDir: dir,
      tables: [0],
      actions: both,
      rows: [
        { table: 0, action: 'insert', mode: 'except', rows: [1] },
        { table: 0, action: 'delete', mode: 'only', rows: [] },
      ],
    });
    expect(some.statements).toEqual([
      'BEGIN',
      `INSERT INTO "items" ("id", "name") VALUES\n(1, 'one'),\n(3, 'o''three')`,
      sqlFiles.insert.statements[1],
      'COMMIT',
    ]);
    expect(some.total).toBe(4);
  });

  it('syncs just the ticked rows, and none past the grid', async () => {
    spool('postgres', sqlTable, sqlFiles);
    const only = await dataSyncScript({
      spoolDir: dir,
      tables: [0],
      actions: { insert: true, update: false, delete: false },
      rows: [{ table: 0, action: 'insert', mode: 'only', rows: [2, 7] }],
    });
    expect(only.statements).toEqual([
      'BEGIN',
      `INSERT INTO "items" ("id", "name") VALUES\n(3, 'o''three')`,
      'COMMIT',
    ]);
    const none = await dataSyncScript({
      spoolDir: dir,
      tables: [0],
      actions: { insert: true, update: false, delete: false },
      rows: [{ table: 0, action: 'insert', mode: 'only', rows: [] }],
    });
    expect(none).toMatchObject({ statements: [], total: 0 });
  });

  it('counts the ticked rows in the script comments', async () => {
    spool('mysql', sqlTable, sqlFiles);
    const path = join(dir, 'out.sql');
    await dataSyncScript({
      spoolDir: dir,
      tables: [0],
      actions: both,
      rows: [{ table: 0, action: 'insert', mode: 'except', rows: [0, 2] }],
      path,
    });
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('-- items: 1 deletes');
    expect(text).toContain('-- items: 3 inserts');
    expect(text).toContain("INSERT INTO `items` (`id`, `name`) VALUES\n(2, 'two');");
  });

  it('builds MongoDB commands again for the ticked documents', async () => {
    const doc = (id: number, a: string) => `{"_id":{"$numberInt":"${id}"},"a":"${a}"}`;
    spool(
      'mongodb',
      table({
        keyColumns: ['_id'],
        counts: { inserts: 2, updates: 0, deletes: 0, equal: 0, sourceRows: 2, targetRows: 0 },
        stored: { insert: 2, update: 0, delete: 0 },
        statements: { insert: 1, update: 0, delete: 0 },
        headStatements: { insert: 1, update: 0, delete: 0 },
      }),
      {
        insert: {
          diffs: [
            { action: 'insert', key: ['1'], sourceRow: ['1', doc(1, 'x')] },
            { action: 'insert', key: ['2'], sourceRow: ['2', doc(2, 'y')] },
          ],
          statements: ['{ insert: "items", documents: [{ _id: 1, a: "x" }, { _id: 2, a: "y" }] }'],
        },
      },
    );
    const some = await dataSyncScript({
      spoolDir: dir,
      tables: [0],
      actions: { insert: true, update: true, delete: true },
      rows: [{ table: 0, action: 'insert', mode: 'except', rows: [0] }],
    });
    expect(some.statements).toEqual(["{ insert: 'items', documents: [ { _id: 2, a: 'y' } ] }"]);
  });

  it('asks for a new compare when the spool cannot rebuild rows', async () => {
    spool('postgres', { ...sqlTable, headStatements: undefined }, sqlFiles);
    await expect(
      dataSyncScript({
        spoolDir: dir,
        tables: [0],
        actions: both,
        rows: [{ table: 0, action: 'insert', mode: 'except', rows: [1] }],
      }),
    ).rejects.toMatchObject({ message: 'This comparison cannot sync only some rows' });
  });
});
