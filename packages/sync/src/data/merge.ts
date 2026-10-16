import type { CellValue, ColumnKind } from '@querybara/core';
import { QuerybaraError } from '@querybara/core';

import type { CanonicalOptions } from './canonical';
import { compareKeyValues, compareKind, valuesEqual } from './canonical';

/** One row as the server returned it, in the order of its side's column list. */
export type Row = readonly CellValue[];

/** What the target needs for one key. */
export type RowAction = 'insert' | 'update' | 'delete';

/** How one key differs (spec §13, data sync step 5). */
export interface RowDiff {
  readonly action: RowAction;
  /** Key values (source side for inserts and updates, target side for deletes). */
  readonly key: readonly CellValue[];
  /** Updates: the compared columns whose values differ. */
  readonly changedColumns?: readonly string[];
  /** In the source's column order; present for inserts and updates. */
  readonly sourceRow?: Row;
  /** In the target's column order; present for updates and deletes. */
  readonly targetRow?: Row;
}

/** Row counts of a merge; `equal` counts keys whose compared values match. */
export interface MergeSummary {
  readonly inserts: number;
  readonly updates: number;
  readonly deletes: number;
  readonly equal: number;
  readonly sourceRows: number;
  readonly targetRows: number;
}

/** Column lists, kinds and rules for merging two row streams. */
export interface MergeOptions {
  /** Key columns, by source name; they must also exist on the target side. */
  readonly keyColumns: readonly string[];
  readonly sourceColumns: readonly string[];
  readonly targetColumns: readonly string[];
  /** Columns to compare (default: every source column the target also has). */
  readonly compareColumns?: readonly string[];
  readonly ignoreColumns?: readonly string[];
  /** ColumnMeta.kind per column name, per side; missing columns compare as strings. */
  readonly sourceKinds?: Readonly<Record<string, ColumnKind>>;
  readonly targetKinds?: Readonly<Record<string, ColumnKind>>;
  readonly canonical?: CanonicalOptions;
}

/** Finds a column by exact name, then case-insensitively (engines differ in name case). */
export function columnIndex(columns: readonly string[], name: string): number {
  const exact = columns.indexOf(name);
  if (exact !== -1) return exact;
  const lower = name.toLowerCase();
  return columns.findIndex((c) => c.toLowerCase() === lower);
}

/** Resolved key positions, key comparison kinds and compared column pairs. */
export interface MergePlan {
  readonly sourceKey: readonly number[];
  readonly targetKey: readonly number[];
  readonly keyKinds: readonly ColumnKind[];
  readonly compared: readonly {
    name: string;
    source: number;
    target: number;
    sourceKind: ColumnKind;
    targetKind: ColumnKind;
    /** The kind both values are compared as (`compareKind` of the two). */
    kind: ColumnKind;
  }[];
}

/** Resolves column positions and comparison kinds; throws when a key column is missing. */
export function planMerge(options: MergeOptions): MergePlan {
  const kindOf = (
    kinds: Readonly<Record<string, ColumnKind>> | undefined,
    name: string,
  ): ColumnKind => {
    if (kinds === undefined) return 'string';
    const direct = kinds[name];
    if (direct !== undefined) return direct;
    const match = Object.keys(kinds).find((k) => k.toLowerCase() === name.toLowerCase());
    return match !== undefined ? (kinds[match] ?? 'string') : 'string';
  };
  const sourceKey = options.keyColumns.map((k) => columnIndex(options.sourceColumns, k));
  const targetKey = options.keyColumns.map((k) => columnIndex(options.targetColumns, k));
  const missing = options.keyColumns.filter((_k, i) => sourceKey[i] === -1 || targetKey[i] === -1);
  if (missing.length > 0) {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: `Key column ${missing.join(', ')} is missing on one side`,
      hint: 'Data compare needs the same primary or unique key on both tables.',
    });
  }
  const ignored = new Set((options.ignoreColumns ?? []).map((c) => c.toLowerCase()));
  const keySet = new Set(options.keyColumns.map((c) => c.toLowerCase()));
  const wanted = options.compareColumns ?? options.sourceColumns;
  const compared: MergePlan['compared'][number][] = [];
  for (const name of wanted) {
    if (ignored.has(name.toLowerCase()) || keySet.has(name.toLowerCase())) continue;
    const source = columnIndex(options.sourceColumns, name);
    const target = columnIndex(options.targetColumns, name);
    if (source === -1 || target === -1) continue;
    const sourceKind = kindOf(options.sourceKinds, name);
    const targetKind = kindOf(options.targetKinds, options.targetColumns[target]!);
    compared.push({
      name,
      source,
      target,
      sourceKind,
      targetKind,
      kind: compareKind(sourceKind, targetKind),
    });
  }
  return {
    sourceKey,
    targetKey,
    keyKinds: options.keyColumns.map((k) =>
      compareKind(kindOf(options.sourceKinds, k), kindOf(options.targetKinds, k)),
    ),
    compared,
  };
}

type AnyRows = Iterable<Row> | AsyncIterable<Row>;

/** Rows in batches, e.g. one batch per fetched page; empty batches are allowed. */
export type RowBatches = Iterable<readonly Row[]> | AsyncIterable<readonly Row[]>;

const SYNC_BATCH = 1000;

/** Single rows as batches: sync input in groups, async input one row per batch. */
async function* batched(rows: AnyRows): AsyncGenerator<readonly Row[]> {
  if (Symbol.asyncIterator in rows) {
    for await (const row of rows) yield [row];
    return;
  }
  let batch: Row[] = [];
  for (const row of rows) {
    batch.push(row);
    if (batch.length === SYNC_BATCH) {
      yield batch;
      batch = [];
    }
  }
  if (batch.length > 0) yield batch;
}

function iterate(batches: RowBatches): AsyncIterator<readonly Row[]> | Iterator<readonly Row[]> {
  return Symbol.asyncIterator in batches
    ? batches[Symbol.asyncIterator]()
    : batches[Symbol.iterator]();
}

/**
 * Reads one side's key-ordered stream, checking the order: a key that goes backwards means the
 * servers sort differently (collation); a repeated key with an identical row (overlapping
 * ranges) is skipped; a repeated key with a different row means the key is not unique.
 *
 * Rows are taken from the current batch synchronously (`take`) and only the batch boundaries
 * wait (`pull`), so the merge does not pay a promise per row.
 */
class OrderedStream {
  private readonly iterator: AsyncIterator<readonly Row[]> | Iterator<readonly Row[]>;
  private batch: readonly Row[] = [];
  private position = 0;
  private previous: Row | undefined;
  count = 0;

  constructor(
    batches: RowBatches,
    private readonly keyIndexes: readonly number[],
    private readonly keyKinds: readonly ColumnKind[],
    private readonly side: 'source' | 'target',
  ) {
    this.iterator = iterate(batches);
  }

  key(row: Row): CellValue[] {
    return this.keyIndexes.map((i) => row[i] ?? null);
  }

  /** The next row of the current batch, or undefined when the batch is used up. */
  take(): Row | undefined {
    while (this.position < this.batch.length) {
      const row = this.batch[this.position++]!;
      if (this.accept(row)) return row;
    }
    return undefined;
  }

  /** The next row, reading further batches as needed; undefined at the end of the stream. */
  async pull(): Promise<Row | undefined> {
    for (;;) {
      const row = this.take();
      if (row !== undefined) return row;
      const result = await this.iterator.next();
      if (result.done) return undefined;
      this.batch = result.value;
      this.position = 0;
    }
  }

  /** Checks a row against the previous one; false for a repeated identical row. */
  private accept(row: Row): boolean {
    if (this.previous !== undefined) {
      const order = compareRowKeys(
        this.previous,
        this.keyIndexes,
        row,
        this.keyIndexes,
        this.keyKinds,
      );
      if (order > 0) {
        throw new QuerybaraError({
          code: 'VALIDATION_FAILED',
          message: `The ${this.side} rows are not sorted by key (at ${JSON.stringify(this.key(row), stringifyCell)})`,
          hint: 'The two servers order the key differently; compare with a binary collation on string keys.',
        });
      }
      if (order === 0) {
        if (sameRow(this.previous, row)) return false;
        throw new QuerybaraError({
          code: 'VALIDATION_FAILED',
          message: `Key ${JSON.stringify(this.key(row), stringifyCell)} is not unique in the ${this.side}`,
        });
      }
    }
    this.previous = row;
    this.count++;
    return true;
  }

  async close(): Promise<void> {
    await this.iterator.return?.();
  }
}

/** `compareKeys` over the key cells of two rows, without copying the keys out. */
function compareRowKeys(
  a: Row,
  aKey: readonly number[],
  b: Row,
  bKey: readonly number[],
  kinds: readonly ColumnKind[],
): number {
  for (let i = 0; i < kinds.length; i++) {
    const result = compareKeyValues(a[aKey[i]!] ?? null, b[bKey[i]!] ?? null, kinds[i]!);
    if (result !== 0) return result;
  }
  return 0;
}

function stringifyCell(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array)
    return `0x${[...value].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  return value;
}

function sameRow(a: Row, b: Row): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, i) => {
    const other = b[i] ?? null;
    if (value instanceof Uint8Array && other instanceof Uint8Array) {
      return value.length === other.length && value.every((byte, j) => byte === other[j]);
    }
    return value === other;
  });
}

/**
 * Merges two key-ordered row streams into insert/update/delete actions (spec §13, step 5).
 * Both inputs must be sorted by the key in the order `compareKeys` defines — which the
 * `rowsQuery` ORDER BY produces. Streams are consumed lazily, so memory stays flat. Returns the
 * counts when the iteration completes.
 */
export function mergeSortedRows(
  source: AnyRows,
  target: AnyRows,
  options: MergeOptions,
): AsyncGenerator<RowDiff, MergeSummary, undefined> {
  return mergeSortedBatches(batched(source), batched(target), options);
}

/** `mergeSortedRows` over rows that arrive in batches, such as fetched pages. */
export async function* mergeSortedBatches(
  source: RowBatches,
  target: RowBatches,
  options: MergeOptions,
): AsyncGenerator<RowDiff, MergeSummary, undefined> {
  const plan = planMerge(options);
  const canonical = options.canonical ?? {};
  const left = new OrderedStream(source, plan.sourceKey, plan.keyKinds, 'source');
  const right = new OrderedStream(target, plan.targetKey, plan.keyKinds, 'target');
  let inserts = 0;
  let updates = 0;
  let deletes = 0;
  let equal = 0;
  try {
    let a = left.take() ?? (await left.pull());
    let b = right.take() ?? (await right.pull());
    while (a !== undefined || b !== undefined) {
      const order =
        a === undefined
          ? 1
          : b === undefined
            ? -1
            : compareRowKeys(a, plan.sourceKey, b, plan.targetKey, plan.keyKinds);
      if (order < 0) {
        inserts++;
        yield { action: 'insert', key: left.key(a!), sourceRow: a! };
        a = left.take() ?? (await left.pull());
      } else if (order > 0) {
        deletes++;
        yield { action: 'delete', key: right.key(b!), targetRow: b! };
        b = right.take() ?? (await right.pull());
      } else {
        const changed: string[] = [];
        for (const c of plan.compared) {
          if (!valuesEqual(a![c.source] ?? null, b![c.target] ?? null, c.kind, c.kind, canonical)) {
            changed.push(c.name);
          }
        }
        if (changed.length > 0) {
          updates++;
          yield {
            action: 'update',
            key: left.key(a!),
            changedColumns: changed,
            sourceRow: a!,
            targetRow: b!,
          };
        } else {
          equal++;
        }
        a = left.take() ?? (await left.pull());
        b = right.take() ?? (await right.pull());
      }
    }
  } finally {
    await left.close();
    await right.close();
  }
  return { inserts, updates, deletes, equal, sourceRows: left.count, targetRows: right.count };
}
