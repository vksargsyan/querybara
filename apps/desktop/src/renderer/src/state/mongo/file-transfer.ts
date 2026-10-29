import { requiresWriteConfirmation } from '@querybara/core';
import type {
  JobInfo,
  MongoExportJob,
  MongoExportFormat,
  MongoFileFormat,
  MongoImportJob,
  MongoImportMode,
} from '@querybara/ipc';
import type { FindQuery, SchemaAnalysis } from '@querybara/mongo-tools';
import { create } from 'zustand';

import { profileById } from '../data';
import { loadChildren, pathKey, useExplorer } from '../explorer';
import { useJobs } from '../jobs';
import { SessionLane } from '../session-lane';

/**
 * Studio 3T's Export and Import for MongoDB (ADR 0037): collections, or the collection tab's
 * query, to JSON, JSON Lines, CSV or BSON files, and such a file into a collection. The dialogs
 * build a `mongo-export` or `mongo-import` job; the job runner streams it, and the job list
 * shows its progress. The write rules apply as for every import: a read-only connection
 * refuses, and a production one (or a replace import) asks first.
 */

export interface MongoExportTarget {
  readonly profileId: string;
  readonly profileName: string;
  readonly db: string;
  /** The collections to start with selected. */
  readonly collections: readonly string[];
  /** The collection tab's query, to export just what it finds. */
  readonly query?: {
    readonly collection: string;
    readonly query: FindQuery;
    /** The find() as the tab shows it. */
    readonly text: string;
  };
}

export interface MongoImportTarget {
  readonly profileId: string;
  readonly profileName: string;
  readonly db: string;
  /** The collection to import into; named after the file when absent. */
  readonly collection?: string;
  readonly readOnly: boolean;
  readonly production: boolean;
  readonly confirmWrites: boolean;
}

export type MongoFileDialog =
  | { readonly kind: 'export'; readonly target: MongoExportTarget }
  | { readonly kind: 'import'; readonly target: MongoImportTarget };

export const useMongoFileDialog = create<{ readonly dialog: MongoFileDialog | undefined }>()(
  () => ({ dialog: undefined }),
);

export function closeMongoFileDialog(): void {
  useMongoFileDialog.setState({ dialog: undefined });
}

export async function openMongoExport(target: {
  readonly profileId: string;
  readonly db: string;
  readonly collections?: readonly string[];
  readonly query?: MongoExportTarget['query'];
}): Promise<void> {
  const profile = await profileById(target.profileId);
  if (!profile) return;
  useMongoFileDialog.setState({
    dialog: {
      kind: 'export',
      target: {
        profileId: profile.id,
        profileName: profile.name,
        db: target.db,
        collections: target.collections ?? (target.query ? [target.query.collection] : []),
        ...(target.query ? { query: target.query } : {}),
      },
    },
  });
}

export async function openMongoImport(target: {
  readonly profileId: string;
  readonly db: string;
  readonly collection?: string;
}): Promise<void> {
  const profile = await profileById(target.profileId);
  if (!profile) return;
  useMongoFileDialog.setState({
    dialog: {
      kind: 'import',
      target: {
        profileId: profile.id,
        profileName: profile.name,
        db: target.db,
        ...(target.collection !== undefined ? { collection: target.collection } : {}),
        readOnly: profile.presentation.readOnly,
        production: profile.presentation.environment === 'production',
        confirmWrites: requiresWriteConfirmation(profile),
      },
    },
  });
}

export const MONGO_FORMAT_LABELS: Readonly<Record<MongoExportFormat, string>> = {
  json: 'JSON',
  jsonl: 'JSON Lines',
  csv: 'CSV',
  bson: 'BSON',
  sql: 'SQL',
};

export const MONGO_FORMAT_HINTS: Readonly<Record<MongoExportFormat, string>> = {
  json: 'An array of documents in Extended JSON',
  jsonl: 'One document per line, as mongoexport writes them',
  csv: 'A column per field, for spreadsheets',
  bson: "Documents back to back, as mongodump's .bson files",
  sql: 'An INSERT statement per document, a column per field',
};

export const MONGO_IMPORT_MODE_LABELS: Readonly<Record<MongoImportMode, string>> = {
  insert: 'Insert',
  upsert: 'Upsert by _id',
  replace: 'Replace the documents',
};

export const MONGO_IMPORT_MODE_HINTS: Readonly<Record<MongoImportMode, string>> = {
  insert: 'Adds the documents; one whose _id is taken is an error',
  upsert: 'Replaces the stored document with the same _id, or adds it',
  replace: 'Deletes every document of the collection first; indexes and validator stay',
};

const EXTENSIONS: Readonly<Record<MongoExportFormat, string>> = {
  json: 'json',
  jsonl: 'jsonl',
  csv: 'csv',
  bson: 'bson',
  sql: 'sql',
};

/** The save dialog's filter for a format. */
export function exportFilters(
  format: MongoExportFormat,
  gzip: boolean,
): { name: string; extensions: string[] }[] {
  return [
    { name: MONGO_FORMAT_LABELS[format], extensions: [gzip ? 'gz' : EXTENSIONS[format]] },
    { name: 'All files', extensions: ['*'] },
  ];
}

/** The file name an export suggests: `orders.json`, `orders.csv.gz`. */
export function exportFileName(
  collection: string,
  format: MongoExportFormat,
  gzip: boolean,
): string {
  // eslint-disable-next-line no-control-regex
  const base = collection.replace(/[\u{0}-\u{1f}<>:"/\\|?*]/gu, '_').replace(/^\.+/, '_');
  return `${base || 'collection'}.${EXTENSIONS[format]}${gzip ? '.gz' : ''}`;
}

export const IMPORT_FILTERS = [
  { name: 'MongoDB data', extensions: ['json', 'jsonl', 'ndjson', 'csv', 'tsv', 'bson', 'gz'] },
  { name: 'All files', extensions: ['*'] },
];

/** The format a file name says (as @querybara/transfer's `mongoFileFormat`). */
export function fileFormat(path: string): MongoFileFormat | undefined {
  const name = path.toLowerCase().replace(/\.gz$/, '');
  if (name.endsWith('.jsonl') || name.endsWith('.ndjson')) return 'jsonl';
  if (name.endsWith('.json')) return 'json';
  if (name.endsWith('.csv') || name.endsWith('.tsv')) return 'csv';
  if (name.endsWith('.bson')) return 'bson';
  return undefined;
}

/** The collection a file suggests: its name without folders and extensions. */
export function collectionFromFile(path: string): string {
  const name = path.split(/[\\/]/).at(-1) ?? '';
  return name.replace(/\.gz$/i, '').replace(/\.(jsonl|ndjson|json|csv|tsv|bson)$/i, '');
}

export interface MongoExportSettings {
  readonly collections: readonly string[];
  /** Export the tab's query instead of every document. */
  readonly useQuery: boolean;
  readonly format: MongoExportFormat;
  readonly ejson: 'relaxed' | 'canonical';
  readonly pretty: boolean;
  /** CSV and SQL columns; empty for those of the first documents. */
  readonly fields: readonly string[];
  readonly delimiter: string;
  readonly header: boolean;
  /** SQL: the table named (empty for the collection's name), and a CREATE TABLE first. */
  readonly sqlTable: string;
  readonly createTable: boolean;
  readonly gzip: boolean;
  readonly path: string | undefined;
}

export function exportSettings(target: MongoExportTarget): MongoExportSettings {
  return {
    collections: target.collections,
    useQuery: target.query !== undefined,
    format: 'json',
    ejson: 'relaxed',
    pretty: false,
    fields: [],
    delimiter: ',',
    header: true,
    sqlTable: '',
    createTable: true,
    gzip: false,
    path: undefined,
  };
}

/** Why the settings cannot export yet, or undefined. */
export function exportIssue(settings: MongoExportSettings): string | undefined {
  if (settings.collections.length === 0) return 'Choose the collections to export';
  if (settings.path === undefined) {
    return settings.collections.length > 1 ? 'Choose a folder' : 'Choose a file';
  }
  return undefined;
}

export function buildExportJob(
  target: MongoExportTarget,
  settings: MongoExportSettings,
): MongoExportJob {
  const query = settings.useQuery && target.query ? target.query : undefined;
  const collections = query ? [query.collection] : [...settings.collections];
  const json = settings.format === 'json' || settings.format === 'jsonl';
  return {
    kind: 'mongo-export',
    profileId: target.profileId,
    database: target.db,
    collections,
    ...(query ? { query: query.query } : {}),
    format: settings.format,
    ...(json ? { ejson: settings.ejson } : {}),
    ...(settings.format === 'json' && settings.pretty ? { pretty: true } : {}),
    ...((settings.format === 'csv' || settings.format === 'sql') && settings.fields.length > 0
      ? { fields: [...settings.fields] }
      : {}),
    ...(settings.format === 'csv'
      ? { csv: { delimiter: settings.delimiter, header: settings.header } }
      : {}),
    ...(settings.format === 'sql'
      ? {
          sql: {
            ...(settings.sqlTable.trim() !== '' ? { table: settings.sqlTable.trim() } : {}),
            ...(settings.createTable ? { createTable: true } : {}),
          },
        }
      : {}),
    ...(settings.gzip ? { gzip: true } : {}),
    output: {
      kind: collections.length > 1 ? 'directory' : 'file',
      path: settings.path!,
    },
  };
}

export interface MongoImportSettings {
  readonly path: string | undefined;
  readonly format: MongoFileFormat;
  readonly collection: string;
  readonly mode: MongoImportMode;
  readonly onError: 'stop' | 'skip';
  readonly delimiter: string;
  readonly header: boolean;
  readonly types: 'infer' | 'string';
  readonly empty: 'omit' | 'null' | 'string';
}

export function importSettings(target: MongoImportTarget): MongoImportSettings {
  return {
    path: undefined,
    format: 'json',
    collection: target.collection ?? '',
    mode: 'insert',
    onError: 'stop',
    delimiter: ',',
    header: true,
    types: 'infer',
    empty: 'omit',
  };
}

/** Settings after a file is picked: its format, and its name for a new collection. */
export function withFile(
  target: MongoImportTarget,
  settings: MongoImportSettings,
  path: string,
): MongoImportSettings {
  const format = fileFormat(path) ?? settings.format;
  return {
    ...settings,
    path,
    format,
    delimiter: /\.tsv(\.gz)?$/i.test(path) ? '\t' : settings.delimiter,
    collection: target.collection ?? (settings.collection || collectionFromFile(path)),
  };
}

export function importIssue(
  target: MongoImportTarget,
  settings: MongoImportSettings,
): string | undefined {
  if (target.readOnly) return 'This connection is read-only';
  if (settings.path === undefined) return 'Choose a file';
  const name = settings.collection.trim();
  if (name === '') return 'Name the collection';
  if (name.includes('$')) return 'A collection name cannot contain $';
  if (name.startsWith('system.')) return 'Names starting with system. are reserved';
  return undefined;
}

export function buildImportJob(
  target: MongoImportTarget,
  settings: MongoImportSettings,
  confirmed: boolean,
): MongoImportJob {
  return {
    kind: 'mongo-import',
    profileId: target.profileId,
    database: target.db,
    collection: settings.collection.trim(),
    file: {
      path: settings.path!,
      format: settings.format,
      ...(settings.format === 'csv'
        ? {
            csv: {
              delimiter: settings.delimiter,
              header: settings.header,
              types: settings.types,
              empty: settings.empty,
            },
          }
        : {}),
    },
    mode: settings.mode,
    onError: settings.onError,
    ...(confirmed ? { confirmed: true } : {}),
  };
}

/** Whether an import asks before it starts, and why. */
export function importQuestion(
  target: MongoImportTarget,
  settings: MongoImportSettings,
): { title: string; message: string; danger: boolean } | undefined {
  const where = `${target.db}.${settings.collection.trim()}`;
  if (settings.mode === 'replace') {
    return {
      title: `Replace the documents of ${where}?`,
      message: `Every document of the collection is deleted first, then the file is imported${
        target.production ? ' on this production connection' : ''
      }. Its indexes and validator stay.`,
      danger: true,
    };
  }
  if (target.confirmWrites) {
    return {
      title: target.production ? 'Import into a production connection?' : 'Import the file?',
      message: `The file's documents are written to ${where} on "${target.profileName}".`,
      danger: target.production,
    };
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// The collections of a database, and the fields of one

/** The collections of a database, as the side bar lists them (read when not loaded yet). */
export async function databaseCollections(profileId: string, db: string): Promise<string[]> {
  const path = [db, 'collections'];
  const known = useExplorer.getState().children[profileId]?.[pathKey(path)]?.nodes;
  if (!known) await loadChildren(profileId, path);
  return (useExplorer.getState().children[profileId]?.[pathKey(path)]?.nodes ?? []).map(
    (node) => node.name,
  );
}

/**
 * CSV columns for a collection: the fields a schema analysis samples, sub-document fields to
 * their leaves, without array elements (an array stays one column).
 */
export function csvFields(analysis: SchemaAnalysis): string[] {
  const paths = analysis.fields
    .filter((field) => !field.path.includes('[]'))
    .map((field) => field.queryPath);
  const unique = [...new Set(paths)];
  const leaves = unique.filter((path) => !unique.some((other) => other.startsWith(`${path}.`)));
  const id = leaves.indexOf('_id');
  if (id > 0) leaves.unshift(...leaves.splice(id, 1));
  return leaves;
}

const lanes = new Map<string, SessionLane>();

function laneFor(profileId: string): SessionLane {
  let lane = lanes.get(profileId);
  if (!lane) {
    lane = new SessionLane(profileId);
    lanes.set(profileId, lane);
  }
  return lane;
}

/** Samples a collection for its CSV columns (Studio 3T's "Scan fields"). */
export async function scanFields(
  profileId: string,
  db: string,
  collection: string,
): Promise<string[]> {
  const analysis = await laneFor(profileId).run((host, sessionId) =>
    host.mongo.analyzeSchema({
      sessionId,
      ns: { db, collection },
      options: { sampleSize: 1000 },
    }),
  );
  return csvFields(analysis);
}

/** After an import: the side bar lists the collection (a new one included). */
export function refreshAfter(jobId: string, profileId: string, db: string): void {
  const done = (job: JobInfo | undefined): boolean => job !== undefined && job.state !== 'running';
  const reload = (): void =>
    void loadChildren(profileId, [db, 'collections']).catch(() => undefined);
  if (done(useJobs.getState().jobs[jobId])) {
    reload();
    return;
  }
  const stop = useJobs.subscribe((state) => {
    if (!done(state.jobs[jobId])) return;
    stop();
    reload();
  });
}
