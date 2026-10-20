import { COLUMN_KINDS, SQL_ENGINE_IDS } from '@querybara/core';
import { dataRowDiffSchema, dataTableResultSchema, type DataRowAction } from '@querybara/ipc';
import { z } from 'zod';

/**
 * The layout of a data compare's spool folder (spec §13, data sync): main makes the folder,
 * the job runner fills it while comparing, main pages the row differences out of it for the
 * grid, and the runner reads the sync statements back to apply them or write a script. Nothing
 * here touches the file system, so both processes (and the tests) share it.
 *
 * - `manifest.json`: the compared tables, their row layout and the apply order;
 * - `rows-<table>-<action>-<page>.json`: up to `SPOOL_PAGE_SIZE` row differences, as display
 *   text, for the first `SPOOL_MAX_ROWS` differences of each table and action;
 * - `sql-<table>-<action>.jsonl`: every sync statement, one JSON string per line;
 * - `diffs-<table>-<action>.jsonl`: the row differences the grid shows, as the compare produced
 *   them (V8-serialised, base64, one per line), so a sync of only some of them can build its
 *   statements again. The builder is flushed after the last of them, so the first
 *   `headStatements` statements cover exactly those rows and the rest cover the rows after.
 *
 * A MongoDB compare spools collections as tables keyed by `_id`; its row pages show the `_id`,
 * the top-level fields concerned and their values, and its statements are command documents.
 */

/** The grid columns of a MongoDB collection's row differences. */
export const MONGO_ROW_COLUMNS = ['_id', 'fields', 'values'] as const;

export const SPOOL_PAGE_SIZE = 100;
/** Row differences kept for the grid per table and action; counts and scripts cover them all. */
export const SPOOL_MAX_ROWS = 10_000;
/** Display text longer than this is cut in the grid. */
export const SPOOL_MAX_CELL = 500;
export const MANIFEST_FILE = 'manifest.json';

export function rowPageFile(table: number, action: DataRowAction, page: number): string {
  return `rows-${table}-${action}-${page}.json`;
}

export function statementsFile(table: number, action: DataRowAction): string {
  return `sql-${table}-${action}.jsonl`;
}

export function diffsFile(table: number, action: DataRowAction): string {
  return `diffs-${table}-${action}.jsonl`;
}

export const rowPageFileSchema = z.array(dataRowDiffSchema);

/** One compared table, with what applying needs to rebuild its statements' frame. */
export const spoolTableSchema = dataTableResultSchema.extend({
  /** Column order of the spooled source rows (key columns first). */
  sourceColumns: z.array(z.string()),
  /** Column order of the spooled target rows, and the target's names. */
  targetColumns: z.array(z.string()),
  targetKinds: z.record(z.string(), z.enum(COLUMN_KINDS)),
  /** Statements per action that cover the stored rows (the first ones of the file). */
  headStatements: z
    .object({
      insert: z.number().int().nonnegative(),
      update: z.number().int().nonnegative(),
      delete: z.number().int().nonnegative(),
    })
    .optional(),
});
export type SpoolTable = z.infer<typeof spoolTableSchema>;

export const spoolManifestSchema = z.object({
  version: z.literal(1),
  /** The target's dialect: the statements are written for it (MongoDB: command documents). */
  dialect: z.enum([...SQL_ENGINE_IDS, 'mongodb']),
  /** MongoDB: the target database the commands run in (scripts switch to it). */
  database: z.string().optional(),
  pageSize: z.number().int().positive(),
  tables: z.array(spoolTableSchema),
  /** Table indexes, referenced tables first (inserts); deletes run in reverse. */
  order: z.array(z.number().int().nonnegative()),
  /** How the compare's options said to apply: without foreign key checks, or triggers. */
  apply: z.object({ disableForeignKeyChecks: z.boolean(), disableTriggers: z.boolean() }),
});
export type SpoolManifest = z.infer<typeof spoolManifestSchema>;
