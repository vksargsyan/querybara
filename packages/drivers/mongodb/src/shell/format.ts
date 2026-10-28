import { inspect, type InspectOptions } from 'node:util';

/**
 * Text of a shell value as mongosh prints it (IntelliShell's raw shell output, ADR 0036): strings
 * as they are, dates as ISODate('…'), BSON values by their constructors, and the shell's own
 * result types (`show dbs`, `show collections`, help) laid out as mongosh lays them out.
 */

const INSPECT: InspectOptions = {
  depth: 6,
  breakLength: 100,
  compact: 3,
  maxArrayLength: 100,
  maxStringLength: 10_000,
  customInspect: true,
};

/** A date that inspects as mongosh shows it. */
class ShellDate {
  constructor(private readonly date: Date) {}

  [inspect.custom](): string {
    return Number.isNaN(this.date.getTime())
      ? 'Invalid Date'
      : `ISODate('${this.date.toISOString()}')`;
  }
}

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * A copy of plain objects and arrays with dates swapped for ShellDate, up to `depth` levels;
 * class instances (BSON values, results) keep their own inspection.
 */
function withShellDates(value: unknown, depth: number, seen: Set<object>): unknown {
  if (value instanceof Date) return new ShellDate(value);
  if (typeof value !== 'object' || value === null || depth < 0 || seen.has(value)) return value;
  if (Array.isArray(value)) {
    seen.add(value);
    const copy = value.map((item: unknown) => withShellDates(item, depth - 1, seen));
    seen.delete(value);
    return copy;
  }
  if (!isPlainObject(value)) return value;
  seen.add(value);
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value))
    copy[key] = withShellDates(item, depth - 1, seen);
  seen.delete(value);
  return copy;
}

/** A value as mongosh prints it inside a document or an array. */
export function inspectValue(value: unknown): string {
  return inspect(withShellDates(value, INSPECT.depth ?? 6, new Set()), INSPECT);
}

/** Bytes as mongosh's `show dbs` shows them ("40.00 KiB"). */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(2)} ${units[unit]}`;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function columns(rows: readonly (readonly [string, string])[]): string {
  const width = Math.max(0, ...rows.map(([name]) => name.length));
  return rows
    .map(([name, rest]) => (rest === '' ? name : `${name.padEnd(width)}  ${rest}`))
    .join('\n');
}

function helpText(printable: unknown): string {
  const help = record(printable);
  const lines: string[] = [];
  if (typeof help['help'] === 'string') lines.push(`  ${help['help']}`, '');
  const attrs = Array.isArray(help['attr']) ? help['attr'].map(record) : [];
  const named = attrs.filter((attr) => typeof attr['name'] === 'string');
  const width = Math.max(0, ...named.map((attr) => String(attr['name']).length));
  for (const attr of named) {
    const description = typeof attr['description'] === 'string' ? attr['description'] : '';
    lines.push(`    ${String(attr['name']).padEnd(width)}  ${description}`.trimEnd());
  }
  if (typeof help['docs'] === 'string') {
    if (lines.length > 0) lines.push('');
    lines.push(`  For more information on usage: ${help['docs']}`);
  }
  return lines.join('\n');
}

/**
 * The text of a statement's value, from mongosh's printable form and its type (`ShellResult`):
 * the raw shell output's line for anything that is not shown as documents.
 */
export function formatPrintable(printable: unknown, type: string | null): string {
  switch (type) {
    case 'ShowDatabasesResult':
      return columns(
        (Array.isArray(printable) ? printable : []).map((item: unknown) => {
          const db = record(item);
          const size = typeof db['sizeOnDisk'] === 'number' ? formatBytes(db['sizeOnDisk']) : '';
          return [String(db['name'] ?? ''), size] as const;
        }),
      );
    case 'ShowCollectionsResult':
      return columns(
        (Array.isArray(printable) ? printable : []).map((item: unknown) => {
          const collection = record(item);
          return [String(collection['name'] ?? ''), String(collection['badge'] ?? '')] as const;
        }),
      );
    case 'Help':
      return helpText(printable);
    case 'ShowBannerResult': {
      const banner = record(printable);
      const content = typeof banner['content'] === 'string' ? banner['content'] : '';
      return typeof banner['header'] === 'string' ? `${banner['header']}\n${content}` : content;
    }
    default:
      return typeof printable === 'string' ? printable : inspectValue(printable);
  }
}

/** The text a print() or printjson() call writes. */
export function formatPrinted(values: readonly unknown[]): string {
  return values.map((value) => (typeof value === 'string' ? value : inspectValue(value))).join(' ');
}
