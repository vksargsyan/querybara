import { QuerybaraError } from '@querybara/core';
import {
  Double,
  EJSON,
  Int32,
  Long,
  ObjectId,
  bsonTypeOf,
  isBsonDocument,
  parseIsoDate,
  toEjson,
  valueEditText,
  type BsonDocument,
  type BsonValue,
  type FindQuery,
  type Namespace,
} from '@querybara/mongo-tools';
import { BSON } from 'bson';

import { CsvFormatter, CsvParser } from './csv';
import { insertDocuments } from './db/mongo-transfer';
import type { MongoTransferSession } from './db/sessions';
import type { ByteSource, Sink } from './io';
import { decodeSource } from './text';
import type { RowError } from './types';

/**
 * MongoDB collections to and from files (ADR 0037), as Studio 3T's and mongoexport's /
 * mongoimport's: JSON (an array of documents), JSON Lines (one document per line), CSV (one
 * column per field, sub-document fields as dotted columns) and BSON (documents back to back,
 * as mongodump writes a collection's `.bson` file).
 *
 * JSON and JSON Lines are Extended JSON, relaxed (mongoexport's default) or canonical, so every
 * type survives; reading takes either, and also mongoexport's pretty output (documents one
 * after another). CSV keeps what a spreadsheet can hold: numbers, strings, booleans and ISO
 * dates as text, and arrays and sub-documents beyond the chosen fields as Extended JSON text;
 * reading it back infers those types again. Everything streams: a page of documents at a time
 * out, a batch at a time in.
 */

export const MONGO_FILE_FORMATS = ['json', 'jsonl', 'csv', 'bson'] as const;
export type MongoFileFormat = (typeof MONGO_FILE_FORMATS)[number];

/**
 * How an import writes: `insert` adds documents (one whose `_id` is taken is an error),
 * `upsert` replaces the stored document with the same `_id` or adds it, `replace` deletes
 * every document first (the collection, its indexes and its validator stay).
 */
export const MONGO_IMPORT_MODES = ['insert', 'upsert', 'replace'] as const;
export type MongoImportMode = (typeof MONGO_IMPORT_MODES)[number];

/** The format a file name says, or undefined. */
export function mongoFileFormat(path: string): MongoFileFormat | undefined {
  const name = path.toLowerCase().replace(/\.gz$/, '');
  if (name.endsWith('.jsonl') || name.endsWith('.ndjson')) return 'jsonl';
  if (name.endsWith('.json')) return 'json';
  if (name.endsWith('.csv') || name.endsWith('.tsv')) return 'csv';
  if (name.endsWith('.bson')) return 'bson';
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Fields and values

/** A value at a dotted path (`items.0.qty`): numbers index arrays. */
export function valueAtField(document: BsonValue, field: string): BsonValue | undefined {
  let current: BsonValue | undefined = document;
  for (const part of field.split('.')) {
    if (Array.isArray(current) && /^\d+$/.test(part)) current = current[Number(part)];
    else if (isBsonDocument(current) && Object.prototype.hasOwnProperty.call(current, part)) {
      current = current[part];
    } else return undefined;
    if (current === undefined) return undefined;
  }
  return current;
}

/**
 * The dotted fields of documents, in the order first seen (`_id` first): sub-documents are
 * followed to their leaves, arrays stay one field.
 */
export function documentFields(documents: Iterable<BsonValue>): string[] {
  const seen = new Set<string>();
  const walk = (value: BsonDocument, prefix: string): void => {
    for (const key of Object.keys(value)) {
      const field = prefix === '' ? key : `${prefix}.${key}`;
      const child = value[key]!;
      if (isBsonDocument(child) && bsonTypeOf(child) === 'object' && Object.keys(child).length) {
        walk(child, field);
      } else seen.add(field);
    }
  };
  for (const document of documents) if (isBsonDocument(document)) walk(document, '');
  const fields = [...seen];
  const id = fields.indexOf('_id');
  if (id > 0) fields.unshift(...fields.splice(id, 1));
  return fields;
}

const PLAIN_TYPES = new Set([
  'string',
  'int',
  'long',
  'double',
  'decimal',
  'bool',
  'date',
  'objectId',
  'uuid',
]);

/**
 * Canonical Extended JSON (as parsed JSON) in relaxed form: numbers and dates as JSON numbers
 * and ISO text, except where that would lose something. An Int64 beyond 2^53, a double that is
 * not finite or is -0, and a date outside 1970–9999 stay canonical. (The bson package's relaxed
 * output rounds such Int64s.)
 */
export function relaxedEjson(canonical: unknown): unknown {
  if (Array.isArray(canonical)) return canonical.map(relaxedEjson);
  if (canonical === null || typeof canonical !== 'object') return canonical;
  const object = canonical as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.length === 1) {
    const value = object[keys[0]!];
    switch (keys[0]) {
      case '$numberInt':
        if (typeof value === 'string') return Number(value);
        break;
      case '$numberLong':
        if (typeof value === 'string') {
          return Number.isSafeInteger(Number(value)) ? Number(value) : object;
        }
        break;
      case '$numberDouble':
        if (typeof value === 'string') {
          const n = Number(value);
          return Number.isFinite(n) && !Object.is(n, -0) ? n : object;
        }
        break;
      case '$date': {
        const ms = (value as { $numberLong?: unknown } | null)?.$numberLong;
        if (typeof ms === 'string') {
          const date = new Date(Number(ms));
          const year = date.getUTCFullYear();
          return year >= 1970 && year <= 9999 ? { $date: date.toISOString() } : object;
        }
        break;
      }
    }
  }
  const out: Record<string, unknown> = {};
  for (const key of keys) out[key] = relaxedEjson(object[key]);
  return out;
}

/** A value as a CSV field: plain text for plain types, relaxed Extended JSON for the rest. */
export function csvFieldText(value: BsonValue | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (PLAIN_TYPES.has(bsonTypeOf(value))) return valueEditText(value);
  return JSON.stringify(relaxedEjson(JSON.parse(toEjson(value))));
}

const INTEGER = /^-?(0|[1-9]\d*)$/;
const DECIMAL = /^-?(0|[1-9]\d*)?\.\d+([eE][+-]?\d+)?$|^-?(0|[1-9]\d*)[eE][+-]?\d+$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * What CSV text reads as when types are inferred: true/false, integers (Int32, else Int64,
 * else Double), decimals (Double), ISO dates and timestamps (Date), a 24-digit hex `_id`
 * (ObjectId), Extended JSON documents and arrays; anything else stays a string.
 */
export function inferCsvValue(text: string, field: string): BsonValue {
  if (text === 'true' || text === 'false') return text === 'true';
  if (INTEGER.test(text)) {
    const n = BigInt(text);
    if (n >= -(2n ** 31n) && n < 2n ** 31n) return new Int32(Number(text));
    if (n >= -(2n ** 63n) && n < 2n ** 63n) return Long.fromBigInt(n);
    return new Double(Number(text));
  }
  if (DECIMAL.test(text)) return new Double(Number(text));
  if (ISO_DAY.test(text) || ISO_TIME.test(text)) {
    const date = parseIsoDate(text.replace(' ', 'T'));
    if (date) return date;
  }
  if (field.split('.').at(-1) === '_id' && /^[0-9a-f]{24}$/i.test(text)) {
    return ObjectId.createFromHexString(text.toLowerCase());
  }
  if (
    (text.startsWith('{') && text.endsWith('}')) ||
    (text.startsWith('[') && text.endsWith(']'))
  ) {
    try {
      return EJSON.parse(text, { relaxed: false }) as BsonValue;
    } catch {
      return text;
    }
  }
  return text;
}

/** Sets `value` at a dotted field of `document`, creating the sub-documents on the way. */
function setField(document: BsonDocument, field: string, value: BsonValue): void {
  const parts = field.split('.');
  let current = document;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (!isBsonDocument(next)) current[part] = {};
    current = current[part] as BsonDocument;
  }
  current[parts.at(-1)!] = value;
}

// ---------------------------------------------------------------------------------------------
// Export

export interface MongoExportOptions {
  readonly format: MongoFileFormat;
  /** JSON and JSON Lines: Extended JSON as mongoexport writes it (relaxed) or canonical. */
  readonly ejson?: 'relaxed' | 'canonical';
  /** JSON: one field per line, indented by two spaces. */
  readonly pretty?: boolean;
  /** CSV: the dotted fields, in order; empty or absent, those of the first 1000 documents. */
  readonly fields?: readonly string[];
  readonly csv?: {
    readonly delimiter?: string;
    readonly header?: boolean;
    readonly lineEnding?: '\n' | '\r\n';
  };
  readonly pageSize?: number;
  readonly signal?: AbortSignal;
  /** Called after each page with the documents and bytes written so far. */
  readonly progress?: (documents: number, bytes: number) => void;
}

export interface MongoExportResult {
  readonly documents: number;
  readonly bytes: number;
  /** CSV: the fields written. */
  readonly fields?: readonly string[];
}

const encoder = new TextEncoder();

/** How many documents a CSV export reads to find its fields when none are given. */
const FIELD_SAMPLE = 1000;

/** Writes the documents a query finds to `sink`, in `options.format`. Closes the sink. */
export async function exportCollection(
  session: MongoTransferSession,
  ns: Namespace,
  query: FindQuery,
  sink: Sink,
  options: MongoExportOptions,
): Promise<MongoExportResult> {
  let documents = 0;
  let bytes = 0;
  const write = async (chunk: Uint8Array | string): Promise<void> => {
    const data = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
    if (data.length === 0) return;
    bytes += data.length;
    await sink.write(data);
  };
  const relaxed = (options.ejson ?? 'relaxed') === 'relaxed';
  // Pages hold canonical Extended JSON already: JSON output needs no BSON values.
  const json = (canonical: string, indent?: number): string =>
    relaxed
      ? JSON.stringify(relaxedEjson(JSON.parse(canonical)), undefined, indent)
      : indent === undefined
        ? canonical
        : JSON.stringify(JSON.parse(canonical), undefined, indent);
  const pages = session.find(ns, query, {
    pageSize: options.pageSize ?? 1000,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  try {
    if (options.format === 'csv') {
      const formatter = new CsvFormatter({
        delimiter: options.csv?.delimiter ?? ',',
        lineEnding: options.csv?.lineEnding ?? '\r\n',
      });
      let fields = options.fields && options.fields.length > 0 ? [...options.fields] : undefined;
      const header = async (): Promise<void> => {
        if (options.csv?.header !== false) await write(formatter.record(fields!));
      };
      const row = async (document: BsonValue): Promise<void> => {
        const values = fields!.map((field) => csvFieldText(valueAtField(document, field)));
        await write(formatter.record(values));
        documents++;
      };
      // Without fields, the first documents name them; they are held until then.
      const held: BsonValue[] = [];
      const start = async (): Promise<void> => {
        fields = documentFields(held);
        await header();
        for (const document of held.splice(0)) await row(document);
      };
      if (fields) await header();
      for await (const page of pages) {
        for (const text of page.documents) {
          const document = EJSON.parse(text, { relaxed: false }) as BsonValue;
          if (fields) await row(document);
          else {
            held.push(document);
            if (held.length >= FIELD_SAMPLE) await start();
          }
        }
        options.progress?.(documents, bytes);
      }
      if (!fields) await start();
      options.progress?.(documents, bytes);
      await sink.close();
      return { documents, bytes, fields: fields ?? [] };
    }
    if (options.format === 'json') await write('[');
    for await (const page of pages) {
      for (const text of page.documents) {
        switch (options.format) {
          case 'bson':
            await write(BSON.serialize(EJSON.parse(text, { relaxed: false }) as BsonDocument));
            break;
          case 'jsonl':
            await write(`${json(text)}\n`);
            break;
          case 'json': {
            const body = options.pretty ? json(text, 2).replace(/\n/g, '\n  ') : json(text);
            await write(`${documents === 0 ? '\n' : ',\n'}  ${body}`);
            break;
          }
        }
        documents++;
      }
      options.progress?.(documents, bytes);
    }
    if (options.format === 'json') await write(documents === 0 ? ']\n' : '\n]\n');
    options.progress?.(documents, bytes);
    await sink.close();
    return { documents, bytes };
  } catch (error) {
    await sink.abort(error);
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Reading files

/** A document read from a file, with where it started (1-based). */
export interface FileDocument {
  /** 1-based position of the document (CSV: the data row). */
  readonly row: number;
  /** 1-based line it starts on (text formats). */
  readonly line?: number;
  readonly document?: BsonDocument;
  /** Why the text is not a document. */
  readonly error?: string;
}

export interface MongoReadOptions {
  readonly format: MongoFileFormat;
  readonly encoding?: string;
  readonly csv?: {
    readonly delimiter?: string;
    /** The first row names the fields (default); without one they are field1, field2... */
    readonly header?: boolean;
    /** `infer` (default) reads numbers, booleans, dates...; `string` keeps every value text. */
    readonly types?: 'infer' | 'string';
    /** An empty field: left out (default), null, or an empty string. */
    readonly empty?: 'omit' | 'null' | 'string';
  };
}

/**
 * Splits JSON text into its top-level values: the elements of an array, or values one after
 * another (JSON Lines, mongoexport's pretty output). Yields each value's text and first line.
 */
export async function* jsonValues(
  chunks: AsyncIterable<string>,
): AsyncGenerator<{ readonly text: string; readonly line: number }> {
  let mode: 'unknown' | 'array' | 'values' = 'unknown';
  // Nesting of the value being read; an array file's outer brackets do not count.
  let depth = 0;
  let inString = false;
  let escaped = false;
  // A value is being read, from `from` in this chunk (and `held` from earlier chunks).
  let reading = false;
  // It is a number, true, false, null or a string: it ends at a separator, not a bracket.
  let bare = false;
  let held = '';
  let line = 1;
  let startLine = 1;
  for await (const chunk of chunks) {
    let from = 0;
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i]!;
      if (c === '\n') line++;
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      const space = c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\uFEFF';
      if (reading && bare && depth === 0 && (space || c === ',' || c === ']')) {
        yield { text: held + chunk.slice(from, i), line: startLine };
        held = '';
        reading = false;
      }
      if (!reading) {
        if (space || c === ',') continue;
        if (mode === 'unknown') {
          mode = c === '[' ? 'array' : 'values';
          if (mode === 'array') continue;
        }
        // The end of an array file: what follows is not read.
        if (c === ']' && mode === 'array') return;
        reading = true;
        bare = c !== '{' && c !== '[';
        startLine = line;
        from = i;
      }
      if (c === '"') inString = true;
      else if (c === '{' || c === '[') depth++;
      else if ((c === '}' || c === ']') && !bare) {
        depth--;
        if (depth === 0) {
          yield { text: held + chunk.slice(from, i + 1), line: startLine };
          held = '';
          reading = false;
        }
      }
    }
    if (reading) held += chunk.slice(from);
  }
  if (reading && held.trim() !== '') yield { text: held.trim(), line: startLine };
}

/** Splits BSON bytes into documents (each starts with its int32 little-endian length). */
export async function* bsonDocuments(source: ByteSource): AsyncGenerator<Uint8Array> {
  let buffer = new Uint8Array(0);
  for await (const chunk of source) {
    const joined = new Uint8Array(buffer.length + chunk.length);
    joined.set(buffer);
    joined.set(chunk, buffer.length);
    buffer = joined;
    let at = 0;
    while (buffer.length - at >= 4) {
      const size = new DataView(buffer.buffer, buffer.byteOffset + at, 4).getInt32(0, true);
      if (size < 5 || size > 48 * 1024 * 1024) {
        throw new QuerybaraError({
          code: 'VALIDATION_FAILED',
          message: 'This is not a BSON file: a document has an impossible length',
        });
      }
      if (buffer.length - at < size) break;
      yield buffer.slice(at, at + size);
      at += size;
    }
    buffer = buffer.slice(at);
  }
  if (buffer.length > 0) {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: 'The BSON file ends inside a document',
    });
  }
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? '' : 's'}`;
}

/** The documents of a file, one at a time, with the problems of those that are not. */
export async function* readDocuments(
  source: ByteSource,
  options: MongoReadOptions,
): AsyncGenerator<FileDocument> {
  if (options.format === 'bson') {
    let row = 0;
    for await (const bytes of bsonDocuments(source)) {
      row++;
      try {
        yield {
          row,
          document: BSON.deserialize(bytes, { promoteValues: false }) as BsonDocument,
        };
      } catch (error) {
        yield { row, error: error instanceof Error ? error.message : String(error) };
      }
    }
    return;
  }
  const text = decodeSource(source, options.encoding ?? 'utf-8');
  if (options.format === 'csv') {
    yield* csvDocuments(text, options.csv ?? {});
    return;
  }
  let row = 0;
  for await (const value of jsonValues(text)) {
    row++;
    try {
      const parsed = EJSON.parse(value.text, { relaxed: false }) as BsonValue;
      if (!isBsonDocument(parsed) || bsonTypeOf(parsed) !== 'object') {
        yield { row, line: value.line, error: 'Not a document: each value must be an object' };
      } else yield { row, line: value.line, document: parsed };
    } catch (error) {
      yield {
        row,
        line: value.line,
        error: `Not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

async function* csvDocuments(
  text: AsyncIterable<string>,
  options: NonNullable<MongoReadOptions['csv']>,
): AsyncGenerator<FileDocument> {
  const parser = new CsvParser({
    delimiter: options.delimiter ?? ',',
    // An empty field is empty text here; `empty` decides what it becomes.
    nullMarker: null,
  });
  let fields: string[] | undefined = options.header === false ? [] : undefined;
  let row = 0;
  const document = (record: (string | null)[], line: number): FileDocument => {
    row++;
    if (fields!.length < record.length) {
      for (let i = fields!.length; i < record.length; i++) fields!.push(`field${i + 1}`);
    }
    const out: BsonDocument = {};
    record.forEach((raw, i) => {
      const field = fields![i]!;
      const value = raw ?? '';
      if (value === '') {
        if (options.empty === 'null') setField(out, field, null);
        else if (options.empty === 'string') setField(out, field, '');
        return;
      }
      setField(out, field, options.types === 'string' ? value : inferCsvValue(value, field));
    });
    return { row, line, document: out };
  };
  const take = function* (batch: { records: (string | null)[][]; lines: number[] }) {
    for (let i = 0; i < batch.records.length; i++) {
      const record = batch.records[i]!;
      if (fields === undefined) {
        fields = record.map((name, at) => (name ?? '').trim() || `field${at + 1}`);
        continue;
      }
      yield document(record, batch.lines[i]!);
    }
  };
  try {
    for await (const chunk of text) yield* take(parser.push(chunk));
    yield* take(parser.end());
  } catch (error) {
    throw error instanceof QuerybaraError
      ? error
      : new QuerybaraError({
          code: 'VALIDATION_FAILED',
          message: `The CSV file could not be read: ${error instanceof Error ? error.message : String(error)}`,
        });
  }
}

// ---------------------------------------------------------------------------------------------
// Import

export interface MongoImportOptions extends MongoReadOptions {
  readonly mode?: MongoImportMode;
  /** `stop` (default) at the first refused document, or `skip` it and go on. */
  readonly onError?: 'stop' | 'skip';
  /** Documents per write; 1000 by default. */
  readonly batchSize?: number;
  readonly signal?: AbortSignal;
  readonly progress?: (counts: MongoImportCounts) => void;
}

export interface MongoImportCounts {
  readonly read: number;
  readonly written: number;
  readonly skipped: number;
}

export interface MongoImportResult extends MongoImportCounts {
  readonly errors: readonly RowError[];
  /** The import stopped at a refused document. */
  readonly stopped: boolean;
  /** `replace`: documents deleted first. */
  readonly deleted: number;
}

/** Most row errors kept for the summary. */
const MAX_ERRORS = 1000;

/** Most bytes of Extended JSON in one write, well under the 48 MB a message may carry. */
const MAX_BATCH_TEXT = 8 * 1024 * 1024;

/** Reads a file's documents into a collection, a batch at a time. */
export async function importCollection(
  session: MongoTransferSession,
  ns: Namespace,
  source: ByteSource,
  options: MongoImportOptions,
): Promise<MongoImportResult> {
  const signal = options.signal ?? new AbortController().signal;
  const onError = options.onError ?? 'stop';
  const batchSize = options.batchSize ?? 1000;
  const mode = options.mode ?? 'insert';
  const errors: RowError[] = [];
  let read = 0;
  let written = 0;
  let skipped = 0;
  let deleted = 0;
  const fail = (error: RowError): void => {
    if (errors.length < MAX_ERRORS) errors.push(error);
  };
  if (mode === 'replace') {
    deleted = (await session.deleteMany(ns, '{}', { signal })).deletedCount;
  }
  let batch: BsonDocument[] = [];
  let rows: number[] = [];
  let size = 0;
  const flush = async (): Promise<boolean> => {
    if (batch.length === 0) return true;
    const documents = batch;
    const at = rows;
    batch = [];
    rows = [];
    size = 0;
    if (mode === 'upsert') {
      const outcome = await upsertDocuments(session, ns, documents, at, onError, signal);
      written += outcome.written;
      skipped += outcome.errors.length;
      outcome.errors.forEach(fail);
      options.progress?.({ read, written, skipped });
      return !outcome.stopped;
    }
    const outcome = await insertDocuments(session, ns, documents, at, onError, signal);
    written += outcome.written;
    skipped += outcome.errors.length;
    outcome.errors.forEach(fail);
    options.progress?.({ read, written, skipped });
    return !outcome.stopped;
  };
  for await (const item of readDocuments(source, options)) {
    if (signal.aborted) throw new QuerybaraError({ code: 'CANCELLED', message: 'Cancelled' });
    read++;
    if (!item.document) {
      fail({
        row: item.row,
        ...(item.line !== undefined ? { line: item.line } : {}),
        message: item.error ?? 'Not a document',
      });
      skipped++;
      if (onError === 'stop') {
        await flush();
        return { read, written, skipped, errors, stopped: true, deleted };
      }
      continue;
    }
    batch.push(item.document);
    rows.push(item.row);
    size += toEjson(item.document).length;
    if (batch.length >= batchSize || size >= MAX_BATCH_TEXT) {
      if (!(await flush())) return { read, written, skipped, errors, stopped: true, deleted };
    }
  }
  const finished = await flush();
  return { read, written, skipped, errors, stopped: !finished, deleted };
}

/** As `insertDocuments`, for the upsert mode. */
async function upsertDocuments(
  session: MongoTransferSession,
  ns: Namespace,
  documents: readonly BsonDocument[],
  rows: readonly number[],
  onError: 'stop' | 'skip',
  signal: AbortSignal,
): Promise<{ written: number; errors: RowError[]; stopped: boolean }> {
  if (!session.upsertMany) {
    throw new QuerybaraError({ code: 'NOT_SUPPORTED', message: 'This session cannot upsert' });
  }
  let written = 0;
  const errors: RowError[] = [];
  let start = 0;
  while (start < documents.length) {
    const batch = start === 0 ? documents : documents.slice(start);
    try {
      await session.upsertMany(ns, toEjson(batch), { signal });
      written += batch.length;
      break;
    } catch (error) {
      const at = signal.aborted ? undefined : failedWrite(error);
      if (at === undefined) throw error;
      written += at;
      errors.push({ row: rows[start + at]!, message: messageOf(error) });
      if (onError === 'stop') return { written, errors, stopped: true };
      start += at + 1;
    }
  }
  return { written, errors, stopped: false };
}

function failedWrite(error: unknown): number | undefined {
  const cause = (error as { cause?: unknown } | null)?.cause as
    { writeErrors?: unknown } | undefined;
  const writeErrors = cause?.writeErrors;
  const first = (Array.isArray(writeErrors) ? writeErrors[0] : writeErrors) as
    { index?: unknown } | undefined;
  return typeof first?.index === 'number' ? first.index : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A summary line: "Imported 1,000 documents, skipped 2". */
export function importOutcome(result: MongoImportResult): string {
  const parts = [`Imported ${plural(result.written, 'document')}`];
  if (result.skipped > 0) parts.push(`skipped ${result.skipped}`);
  if (result.deleted > 0) parts.push(`after deleting ${plural(result.deleted, 'document')}`);
  return parts.join(', ');
}
