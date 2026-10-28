import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { QuerybaraError } from '@querybara/core';
import type { MongoExportJob, MongoImportJob } from '@querybara/ipc';
import {
  asMongo,
  exportCollection,
  fileSink,
  fileSource,
  importCollection,
  importOutcome,
  openInput,
} from '@querybara/transfer';

import type { JobContext, JobOutcome } from './tasks';

/**
 * MongoDB collections to and from files in the job runner (ADR 0037): `mongo-export` writes one
 * collection (or the collection tab's query) to a file, or several to a folder, as JSON, JSON
 * Lines, CSV or BSON; `mongo-import` reads such a file into a collection. Main has checked the
 * paths and the profile's write rules; a read-only profile is refused here again.
 */

const EXTENSIONS: Readonly<Record<MongoExportJob['format'], string>> = {
  json: 'json',
  jsonl: 'jsonl',
  csv: 'csv',
  bson: 'bson',
};

/** A collection's file name in an export folder: `orders.json`, `orders.csv.gz`. */
export function mongoExportFileName(
  collection: string,
  format: MongoExportJob['format'],
  gzip = false,
): string {
  // eslint-disable-next-line no-control-regex
  const base = collection.replace(/[\u{0}-\u{1f}<>:"/\\|?*]/gu, '_').replace(/^\.+/, '_');
  return `${base || 'collection'}.${EXTENSIONS[format]}${gzip ? '.gz' : ''}`;
}

export async function runMongoExport(
  job: MongoExportJob,
  context: JobContext,
): Promise<JobOutcome> {
  const session = asMongo(context.session);
  const { signal } = context;
  if (job.collections.length > 1 && job.output.kind === 'file') {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: 'Several collections export to a folder, a file each',
    });
  }
  if (job.query !== undefined && job.collections.length > 1) {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: 'A query exports one collection',
    });
  }
  const started = performance.now();
  const files: string[] = [];
  const tables: {
    table: string;
    status: 'completed';
    rowsWritten: number;
    bytesWritten: number;
  }[] = [];
  let documents = 0;
  let bytes = 0;
  for (const collection of job.collections) {
    if (signal.aborted) throw new QuerybaraError({ code: 'CANCELLED', message: 'Cancelled' });
    const path =
      job.output.kind === 'file'
        ? job.output.path
        : join(job.output.path, mongoExportFileName(collection, job.format, job.gzip === true));
    files.push(path);
    const before = { documents, bytes };
    context.progress({
      phase: `Exporting ${collection}`,
      table: collection,
      rowsWritten: documents,
      bytes,
    });
    const result = await exportCollection(
      session,
      { db: job.database, collection },
      job.query ?? {},
      fileSink(path, { gzip: job.gzip === true }),
      {
        format: job.format,
        ...(job.ejson !== undefined ? { ejson: job.ejson } : {}),
        ...(job.pretty === true ? { pretty: true } : {}),
        ...(job.fields !== undefined ? { fields: job.fields } : {}),
        ...(job.csv !== undefined ? { csv: job.csv } : {}),
        signal,
        progress: (written, size) =>
          context.progress({
            phase: `Exporting ${collection}`,
            table: collection,
            rowsRead: before.documents + written,
            rowsWritten: before.documents + written,
            bytes: before.bytes + size,
          }),
      },
    );
    documents += result.documents;
    bytes += result.bytes;
    tables.push({
      table: collection,
      status: 'completed',
      rowsWritten: result.documents,
      bytesWritten: result.bytes,
    });
    if (result.fields !== undefined && job.fields === undefined) {
      context.log('info', `${collection}: ${result.fields.length} fields as CSV columns`);
    }
    context.log(
      'info',
      `Exported ${result.documents} ${result.documents === 1 ? 'document' : 'documents'} of ${collection}`,
    );
  }
  return {
    summary: {
      status: 'completed',
      rowsRead: documents,
      rowsWritten: documents,
      rowsSkipped: 0,
      bytesWritten: bytes,
      durationMs: Math.round(performance.now() - started),
      ...(tables.length > 1 ? { tables } : {}),
      files,
    },
    errors: [],
  };
}

export async function runMongoImport(
  job: MongoImportJob,
  context: JobContext,
): Promise<JobOutcome> {
  if (context.readOnly) {
    throw new QuerybaraError({
      code: 'READ_ONLY',
      message: 'This connection is read-only, so nothing can be imported into it',
    });
  }
  const session = asMongo(context.session);
  const { signal } = context;
  const started = performance.now();
  const totalBytes = (await stat(job.file.path)).size;
  const input = await openInput(fileSource(job.file.path));
  const ns = { db: job.database, collection: job.collection };
  context.progress({ phase: `Importing into ${job.collection}`, totalBytes, rowsWritten: 0 });
  if (job.mode === 'replace') context.log('info', `Deleting the documents of ${job.collection}`);
  const result = await importCollection(session, ns, input.source, {
    format: job.file.format,
    mode: job.mode,
    ...(job.file.encoding !== undefined ? { encoding: job.file.encoding } : {}),
    ...(job.file.csv !== undefined ? { csv: job.file.csv } : {}),
    ...(job.onError !== undefined ? { onError: job.onError } : {}),
    ...(job.batchSize !== undefined ? { batchSize: job.batchSize } : {}),
    signal,
    progress: (counts) =>
      context.progress({
        phase: `Importing into ${job.collection}`,
        rowsRead: counts.read,
        rowsWritten: counts.written,
        rowsSkipped: counts.skipped,
        bytes: input.count(),
        totalBytes,
      }),
  });
  if (result.deleted > 0) {
    context.log('info', `Deleted ${result.deleted} documents of ${job.collection} first`);
  }
  context.log(result.stopped ? 'error' : 'info', importOutcome(result));
  return {
    summary: {
      status: result.stopped ? 'failed' : 'completed',
      rowsRead: result.read,
      rowsWritten: result.written,
      rowsSkipped: result.skipped,
      durationMs: Math.round(performance.now() - started),
      outcome: importOutcome(result),
    },
    errors: result.errors.map((error) => ({
      ...(error.row !== undefined ? { row: error.row } : {}),
      ...(error.line !== undefined ? { line: error.line } : {}),
      table: job.collection,
      message: error.message,
    })),
  };
}
