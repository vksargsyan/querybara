import { QuerybaraError, type Session } from '@querybara/core';
import {
  copiedIndexes,
  formatShellInline,
  fromEjson,
  isBsonDocument,
  type BsonDocument,
  type IndexSpec,
  type Namespace,
} from '@querybara/mongo-tools';

import type { RowError } from '../types';
import { insertDocuments } from './mongo-transfer';
import type { Execution, TransferUnit, UnitContext, UnitResult } from './pipeline';
import { asMongo, type MongoTransferSession } from './sessions';
import type { DbTableMode, DbTransferOptions, DbTransferSpec, PlannedTable } from './spec';

/**
 * MongoDB → MongoDB transfers (ADR 0036: Studio 3T's Paste Collection and Copy Collection to
 * another connection): each collection's documents stream across as they are, every BSON type
 * kept, in ordered batches, then its indexes are created on the copy. A collection's options
 * (validator, capped size, collation, time series) are not copied; the plan warns when it has
 * some.
 */

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shellName(ns: Namespace): string {
  return /^[A-Za-z_$][\w$]*$/.test(ns.collection)
    ? `db.${ns.collection}`
    : `db.getCollection(${JSON.stringify(ns.collection)})`;
}

async function infoOf(session: MongoTransferSession, ns: Namespace) {
  try {
    return await session.collectionInfo(ns);
  } catch (error) {
    if (error instanceof QuerybaraError && error.code === 'NOT_FOUND') return undefined;
    throw error;
  }
}

/** The options of a collection that a plain copy leaves behind, for the plan's warning. */
function droppedOptions(options: string): string[] {
  const value = fromEjson(options, 'collection options');
  if (!isBsonDocument(value)) return [];
  const names: Record<string, string> = {
    validator: 'its validator',
    capped: 'capped size',
    collation: 'its default collation',
    timeseries: 'time series settings',
    clusteredIndex: 'its clustered index',
    changeStreamPreAndPostImages: 'change stream images',
  };
  return Object.keys(value)
    .filter((key) => key in names)
    .map((key) => names[key]!);
}

interface CollectionCopy {
  readonly planned: PlannedTable;
  readonly from: Namespace;
  readonly to: Namespace;
  readonly indexes: readonly IndexSpec[];
}

function copyUnit(copy: CollectionCopy): TransferUnit {
  return {
    source: copy.planned.source,
    target: copy.planned.target,
    async load(context: UnitContext): Promise<UnitResult> {
      const source = asMongo(context.source);
      const target = asMongo(context.target);
      const { options, signal } = context;
      let read = 0;
      let written = 0;
      let skipped = 0;
      const errors: RowError[] = [];
      try {
        for await (const page of source.find(
          copy.from,
          { sort: '{"_id": 1}' },
          { pageSize: options.batchSize, signal },
        )) {
          const documents: BsonDocument[] = [];
          const rows: number[] = [];
          for (const text of page.documents) {
            read++;
            documents.push(fromEjson(text, 'document') as BsonDocument);
            rows.push(read);
          }
          const result = await insertDocuments(
            target,
            copy.to,
            documents,
            rows,
            options.onError,
            signal,
          );
          written += result.written;
          skipped += result.errors.length;
          errors.push(...result.errors);
          context.progress({ read, written, skipped });
          if (result.stopped) return { status: 'failed', read, written, skipped, errors };
        }
      } catch (error) {
        if (signal.aborted) return { status: 'cancelled', read, written, skipped, errors };
        errors.push({ message: messageOf(error) });
        return { status: 'failed', read, written, skipped, errors };
      }
      return { status: signal.aborted ? 'cancelled' : 'completed', read, written, skipped, errors };
    },
    async finish(context: UnitContext): Promise<void> {
      const target = asMongo(context.target);
      for (const spec of copy.indexes) await target.createIndex(copy.to, spec);
    },
  };
}

/** Plans a MongoDB → MongoDB transfer. */
export async function mongoToMongoExecution(
  spec: DbTransferSpec,
  options: DbTransferOptions,
  sourceSession: Session,
  targetSession: Session,
): Promise<Execution> {
  const source = asMongo(sourceSession);
  const target = asMongo(targetSession);
  const sourceDb = spec.source.database || source.currentDatabase;
  const targetDb = spec.target.database || target.currentDatabase;
  const copies: CollectionCopy[] = [];
  const problems: string[] = [];
  const warnings: string[] = [];
  const before: { ns: Namespace; mode: DbTableMode; exists: boolean }[] = [];
  const seen = new Set<string>();
  for (const object of spec.objects) {
    const name = object.target?.trim() || object.name;
    const from = { db: sourceDb, collection: object.name };
    const to = { db: targetDb, collection: name };
    const mode = object.mode ?? options.mode;
    const tableProblems: string[] = [];
    const tableWarnings: string[] = [];
    const [info, existing] = await Promise.all([infoOf(source, from), infoOf(target, to)]);
    if (!info) tableProblems.push(`Collection ${object.name} was not found on the source`);
    else if (info.type === 'view') {
      tableProblems.push(`${object.name} is a view: copy the collection it reads instead`);
    }
    if (seen.has(name)) tableProblems.push(`Two collections are transferred into ${name}`);
    seen.add(name);
    const exists = existing !== undefined;
    if (exists && mode === 'create') {
      tableProblems.push(
        `${name} already exists on the target; choose drop and create, truncate or append`,
      );
    }
    let indexes: IndexSpec[] = [];
    let count: number | undefined;
    if (info && info.type !== 'view') {
      const left = droppedOptions(info.options);
      if (left.length > 0) {
        tableWarnings.push(`The copy is a plain collection: ${left.join(', ')} not copied`);
      }
      [indexes, count] = await Promise.all([
        source.listIndexes(from).then(copiedIndexes),
        source.estimatedCount(from).catch(() => undefined),
      ]);
    }
    const planned: PlannedTable = {
      source: object.name,
      target: name,
      kind: 'collection',
      action: exists ? mode : 'create',
      exists,
      ...(count !== undefined ? { rows: count } : {}),
      columns: [],
      problems: tableProblems,
      warnings: tableWarnings,
    };
    problems.push(...tableProblems.map((p) => `${object.name}: ${p}`));
    warnings.push(...tableWarnings.map((w) => `${object.name}: ${w}`));
    copies.push({ planned, from, to, indexes });
    if (tableProblems.length === 0) before.push({ ns: to, mode, exists });
  }
  const commands: string[] = [];
  const destructive: string[] = [];
  const creates: string[] = [];
  for (const { ns, mode, exists } of before) {
    if (exists && mode === 'drop-create') {
      commands.push(
        `${shellName(ns)}.drop()`,
        `db.createCollection(${JSON.stringify(ns.collection)})`,
      );
      destructive.push(`Drop collection ${ns.collection} (it exists) and create it again`);
      creates.push(`Create collection ${ns.collection}`);
    } else if (exists && mode === 'truncate') {
      commands.push(`${shellName(ns)}.deleteMany({})`);
      destructive.push(`Empty collection ${ns.collection}: every document in it now is deleted`);
    } else if (!exists) {
      commands.push(`db.createCollection(${JSON.stringify(ns.collection)})`);
      creates.push(`Create collection ${ns.collection}`);
    }
  }
  const after = copies.flatMap((copy) =>
    copy.indexes.map(
      (index) =>
        `${shellName(copy.to)}.createIndex(${formatShellInline(fromEjson(index.keys))}, ${JSON.stringify({ name: index.name, ...(index.unique ? { unique: true } : {}) })})`,
    ),
  );
  return {
    plan: {
      sourceEngine: source.engine,
      targetEngine: target.engine,
      sourceVersion: source.serverVersion,
      targetVersion: target.serverVersion,
      tables: copies.map((copy) => copy.planned),
      before: commands,
      after,
      destructive,
      creates,
      problems,
      warnings,
    },
    async prepare(session) {
      const mongo = asMongo(session);
      for (const { ns, mode, exists } of before) {
        if (exists && mode === 'drop-create') {
          await mongo.dropCollection(ns);
          await mongo.createCollection(ns);
        } else if (exists && mode === 'truncate') {
          await mongo.deleteMany(ns, '{}');
        } else if (!exists) {
          await mongo.createCollection(ns);
        }
      }
    },
    units: copies.filter((copy) => copy.planned.problems.length === 0).map(copyUnit),
  };
}
