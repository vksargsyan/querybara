import { QuerybaraError } from '@querybara/core';
import type { IndexDef, SchemaSnapshot, TableDef, ViewDef } from '@querybara/core';
import type { BsonDocument, BsonValue } from '@querybara/mongo-tools';
import { formatShell, fromEjson, isBsonDocument, quoteShellString } from '@querybara/mongo-tools';

import { OperationBuilder, step } from '../diff/builder';
import type { SchemaDiff, SyncWarning } from '../model';
import type { CompareOptions, ResolvedCompareOptions } from '../options';
import { resolveCompareOptions } from '../options';
import { canonicalBson } from './bson';

/**
 * MongoDB structure diff (spec §13, "compare and sync indexes, validators and collection
 * options"): collections with their options and validators, indexes and views of one database,
 * read by the driver's introspection into a SchemaSnapshot (collections as tables, the `_id`
 * index as the primary key, each index's full spec in `definition`, collection options as
 * strings).
 *
 * Statements are command documents in shell syntax, which a MongoDB session runs as they are
 * (`{ createIndexes: 'users', indexes: [...] }`); `generateScript` wraps them in
 * `db.runCommand(...)` for mongosh. Changes MongoDB can only make by re-creating a collection
 * and copying its documents (capped, time series, clustered, default collation) are reported
 * unscripted.
 *
 * Options that apply: `ignoreNames` (match indexes by definition), `ignoreCollation`
 * (collection and index collations). Names are always case-sensitive.
 */

/** Execution buckets: drops of views and indexes first, then collections, then creates. */
const PHASE = {
  dropView: 10,
  dropIndex: 20,
  dropCollection: 30,
  createCollection: 40,
  alterCollection: 50,
  createIndex: 60,
  createView: 70,
  alterView: 80,
} as const;

const key = {
  /** Collections and views share one namespace. */
  object: (name: string): string => `obj:${name}`,
  indexName: (collection: string, name: string): string => `idx:${collection}:${name}`,
  indexKeys: (collection: string, keys: string): string => `idxkey:${collection}:${keys}`,
};

/** A statement: one command document, in shell syntax that parses back to the same BSON. */
function command(doc: BsonDocument): string {
  return formatShell(doc);
}

function parse(text: string | undefined, what: string): BsonValue | undefined {
  if (text === undefined || text === '') return undefined;
  return fromEjson(text, what);
}

function parseDocument(text: string | undefined, what: string): BsonDocument | undefined {
  const value = parse(text, what);
  return isBsonDocument(value) ? value : undefined;
}

/** `db.getCollection('name')`, or `db.name` when the name is a plain identifier. */
function collectionRef(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) && !['getCollection', 'runCommand'].includes(name)
    ? `db.${name}`
    : `db.getCollection(${quoteShellString(name)})`;
}

// ---------------------------------------------------------------------------------------------
// Collections

/** Collection options a `create` command takes, in the order mongosh prints them. */
function createOptions(table: TableDef): BsonDocument {
  const o = table.options;
  const out: BsonDocument = {};
  if (o['capped'] === 'true') {
    out['capped'] = true;
    if (o['size'] !== undefined) out['size'] = Number(o['size']);
    if (o['max'] !== undefined) out['max'] = Number(o['max']);
  }
  const timeseries = parseDocument(o['timeseries'], 'time series options');
  if (timeseries !== undefined) out['timeseries'] = timeseries;
  const clustered = parseDocument(o['clusteredIndex'], 'clustered index');
  if (clustered !== undefined) {
    const { v: _v, ...rest } = clustered;
    out['clusteredIndex'] = rest;
  }
  if (o['expireAfterSeconds'] !== undefined) {
    out['expireAfterSeconds'] = Number(o['expireAfterSeconds']);
  }
  const collation = parseDocument(o['collation'], 'collation');
  if (collation !== undefined) out['collation'] = collation;
  const validator = parseDocument(o['validator'], 'validator');
  if (validator !== undefined && Object.keys(validator).length > 0) {
    out['validator'] = validator;
    if (o['validationLevel'] !== undefined) out['validationLevel'] = o['validationLevel'];
    if (o['validationAction'] !== undefined) out['validationAction'] = o['validationAction'];
  }
  const images = parseDocument(o['changeStreamPreAndPostImages'], 'change stream images');
  if (images !== undefined && images['enabled'] === true) {
    out['changeStreamPreAndPostImages'] = { enabled: true };
  }
  return out;
}

function collectionDdl(table: TableDef): string {
  const options = createOptions(table);
  const lines = [
    Object.keys(options).length > 0
      ? `db.createCollection(${quoteShellString(table.name)}, ${formatShell(options)})`
      : `db.createCollection(${quoteShellString(table.name)})`,
  ];
  for (const index of table.indexes) lines.push(indexDdl(table.name, index));
  return lines.join('\n');
}

/** Option values with server defaults filled in, so an omitted default equals its value. */
interface CollectionShape {
  readonly kind: string;
  readonly capped: string;
  readonly size: string;
  readonly max: string;
  readonly timeseries: string;
  readonly clustered: string;
  readonly collation: string;
  readonly expireAfterSeconds: string;
  readonly validator: string;
  readonly validationLevel: string;
  readonly validationAction: string;
  readonly changeStreamImages: boolean;
}

function canonicalOption(text: string | undefined, what: string): string {
  const value = parse(text, what);
  if (value === undefined) return '';
  if (isBsonDocument(value)) {
    const { v: _v, ...rest } = value;
    return canonicalBson(rest, { ignoreNumericTypes: true });
  }
  return canonicalBson(value, { ignoreNumericTypes: true });
}

function collectionShape(table: TableDef, options: ResolvedCompareOptions): CollectionShape {
  const o = table.options;
  const validator = canonicalOption(o['validator'], 'validator');
  const images = parseDocument(o['changeStreamPreAndPostImages'], 'change stream images');
  return {
    kind: o['type'] === 'timeseries' ? 'time series collection' : 'collection',
    capped: o['capped'] === 'true' ? 'capped' : '',
    size: o['capped'] === 'true' ? (o['size'] ?? '') : '',
    max: o['capped'] === 'true' ? (o['max'] ?? '') : '',
    timeseries: canonicalOption(o['timeseries'], 'time series options'),
    clustered: canonicalOption(o['clusteredIndex'], 'clustered index'),
    collation: options.ignoreCollation ? '' : canonicalOption(o['collation'], 'collation'),
    expireAfterSeconds: o['expireAfterSeconds'] ?? '',
    validator: validator === '{}' ? '' : validator,
    // The server's defaults, whether or not a validator is set, so that adding one with the
    // default level and action changes only the validator.
    validationLevel: o['validationLevel'] ?? 'strict',
    validationAction: o['validationAction'] ?? 'error',
    changeStreamImages: images?.['enabled'] === true,
  };
}

// ---------------------------------------------------------------------------------------------
// Indexes

/** The createIndexes entry of an index: its spec without version and namespace. */
function indexSpec(index: IndexDef): BsonDocument {
  const spec = parseDocument(index.definition, `index ${index.name}`);
  if (spec !== undefined) {
    const { v: _v, ns: _ns, ...rest } = spec;
    return rest;
  }
  // Snapshots from elsewhere may lack the definition: rebuild the essentials.
  const keys: BsonDocument = {};
  for (const column of index.columns) {
    if (column.name === null) continue;
    keys[column.name] = column.expression ?? (column.order === 'desc' ? -1 : 1);
  }
  return {
    key: keys,
    name: index.name,
    ...(index.unique ? { unique: true } : {}),
    ...(index.invisible ? { hidden: true } : {}),
    ...(index.where !== undefined ? { partialFilterExpression: fromEjson(index.where) } : {}),
  };
}

/** Options that change nothing when false or absent; the server stores what it was given. */
const FALSE_DEFAULTS = ['unique', 'sparse', 'hidden', 'background'];

/** Fields of an index spec in canonical form, keyed by option name ('key' keeps its order). */
function indexFields(
  index: IndexDef,
  options: ResolvedCompareOptions,
): { keys: string; fields: Map<string, string> } {
  const spec = indexSpec(index);
  const fields = new Map<string, string>();
  for (const [name, value] of Object.entries(spec)) {
    if (name === 'key' || name === 'background') continue;
    if (name === 'name' && options.ignoreNames) continue;
    if (name === 'collation' && options.ignoreCollation) continue;
    if (FALSE_DEFAULTS.includes(name) && value === false) continue;
    fields.set(name, canonicalBson(value, { ignoreNumericTypes: true }));
  }
  const keys = canonicalBson(spec['key'] ?? {}, {
    ignoreFieldOrder: false,
    ignoreNumericTypes: true,
  });
  return { keys, fields };
}

function indexDdl(collection: string, index: IndexDef): string {
  const { key: keys, ...rest } = indexSpec(index);
  return `${collectionRef(collection)}.createIndex(${formatShell(keys ?? {})}, ${formatShell(rest)})`;
}

// ---------------------------------------------------------------------------------------------
// Views

function viewSpec(view: ViewDef): BsonDocument {
  const pipeline = parse(view.definition, `pipeline of ${view.name}`) ?? [];
  const collation = parseDocument(view.options['collation'], 'collation');
  return {
    viewOn: view.options['viewOn'] ?? '',
    pipeline: Array.isArray(pipeline) ? pipeline : [],
    ...(collation !== undefined ? { collation } : {}),
  };
}

function viewDdl(view: ViewDef): string {
  const spec = viewSpec(view);
  const args = [
    quoteShellString(view.name),
    quoteShellString(String(spec['viewOn'])),
    formatShell(spec['pipeline']!),
    ...(spec['collation'] !== undefined ? [formatShell({ collation: spec['collation'] })] : []),
  ];
  return `db.createView(${args.join(', ')})`;
}

// ---------------------------------------------------------------------------------------------
// Diff

function byName<T extends { name: string }>(items: readonly T[]): Map<string, T> {
  return new Map(items.map((item) => [item.name, item]));
}

function onlyDatabase(snapshot: SchemaSnapshot, side: string): SchemaSnapshot['schemas'][number] {
  const schema = snapshot.schemas[0];
  if (schema === undefined) {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: `The ${side} snapshot holds no database`,
    });
  }
  return schema;
}

class MongoDiff {
  readonly builder = new OperationBuilder();

  constructor(private readonly options: ResolvedCompareOptions) {}

  createCollection(table: TableDef): void {
    const steps = [
      step(PHASE.createCollection, [command({ create: table.name, ...createOptions(table) })], {
        provides: [key.object(table.name)],
      }),
    ];
    if (table.indexes.length > 0) {
      steps.push(
        step(
          PHASE.createIndex,
          [command({ createIndexes: table.name, indexes: table.indexes.map(indexSpec) })],
          {
            provides: table.indexes.map((i) => key.indexName(table.name, i.name)),
            refs: [key.object(table.name)],
          },
        ),
      );
    }
    this.builder.add({
      id: `collection:${table.name}:create`,
      kind: 'create',
      objectKind: 'collection',
      name: table.name,
      qualifiedName: table.name,
      steps,
      sourceDdl: collectionDdl(table),
      changes: table.indexes.map((i) => `index ${i.name}`),
    });
  }

  dropCollection(table: TableDef): void {
    this.builder.add({
      id: `collection:${table.name}:drop`,
      kind: 'drop',
      objectKind: 'collection',
      name: table.name,
      qualifiedName: table.name,
      steps: [
        step(PHASE.dropCollection, [command({ drop: table.name })], {
          removes: [key.object(table.name)],
        }),
      ],
      targetDdl: collectionDdl(table),
      destructive: true,
      warnings: [{ code: 'data-loss', message: 'Drops the collection with its documents' }],
    });
  }

  alterCollection(source: TableDef, target: TableDef): void {
    const a = collectionShape(source, this.options);
    const b = collectionShape(target, this.options);
    const name = source.name;
    const base = {
      objectKind: 'collection' as const,
      name,
      qualifiedName: name,
      sourceDdl: collectionDdl(source),
      targetDdl: collectionDdl(target),
    };

    // What only re-creating the collection (and copying its documents) can change.
    const fixed: string[] = [];
    if (a.kind !== b.kind) fixed.push(`kind: ${b.kind} → ${a.kind}`);
    if (a.capped !== b.capped) {
      fixed.push(a.capped !== '' ? 'capped: no → yes' : 'capped: yes → no');
    }
    if (a.timeseries !== b.timeseries && a.kind === b.kind) fixed.push('time series options');
    if (a.clustered !== b.clustered) fixed.push('clustered index');
    if (a.collation !== b.collation) fixed.push('default collation');
    if (fixed.length > 0) {
      this.builder.add({
        ...base,
        id: `collection:${name}:recreate`,
        kind: 'alter',
        steps: [],
        changes: fixed,
        unsupported: true,
        warnings: [
          {
            code: 'unsupported',
            message:
              'MongoDB cannot change this on an existing collection: create a new collection with the source options and copy the documents into it',
          },
        ],
      });
    }

    const mod: BsonDocument = { collMod: name };
    const changes: string[] = [];
    const warnings: SyncWarning[] = [];
    if (a.validator !== b.validator) {
      const validator = parseDocument(source.options['validator'], 'validator') ?? {};
      mod['validator'] = validator;
      changes.push(
        a.validator === ''
          ? 'validator removed'
          : b.validator === ''
            ? 'validator added'
            : 'validator',
      );
      if (a.validator !== '') {
        warnings.push({
          code: 'info',
          message:
            'Documents already in the collection are not checked against the new validator; they are when next updated',
        });
      }
    }
    if (a.validationLevel !== b.validationLevel && a.validator !== '') {
      mod['validationLevel'] = a.validationLevel;
      changes.push(`validationLevel: ${b.validationLevel} → ${a.validationLevel}`);
    }
    if (a.validationAction !== b.validationAction && a.validator !== '') {
      mod['validationAction'] = a.validationAction;
      changes.push(`validationAction: ${b.validationAction} → ${a.validationAction}`);
    }
    if (a.expireAfterSeconds !== b.expireAfterSeconds && a.kind === b.kind) {
      mod['expireAfterSeconds'] =
        a.expireAfterSeconds === '' ? 'off' : Number(a.expireAfterSeconds);
      changes.push(
        `expireAfterSeconds: ${b.expireAfterSeconds || 'off'} → ${a.expireAfterSeconds || 'off'}`,
      );
      if (
        a.expireAfterSeconds !== '' &&
        (b.expireAfterSeconds === '' || Number(a.expireAfterSeconds) < Number(b.expireAfterSeconds))
      ) {
        warnings.push({
          code: 'data-loss',
          message: 'Documents older than the new expiry are deleted by the TTL monitor',
        });
      }
    }
    if (a.capped !== '' && b.capped !== '' && (a.size !== b.size || a.max !== b.max)) {
      if (a.size !== b.size && a.size !== '') {
        mod['cappedSize'] = Number(a.size);
        changes.push(`size: ${b.size} → ${a.size}`);
      }
      if (a.max !== b.max) {
        mod['cappedMax'] = a.max === '' ? 0 : Number(a.max);
        changes.push(`max: ${b.max || 'none'} → ${a.max || 'none'}`);
      }
      warnings.push({
        code: 'may-fail',
        message: 'Resizing a capped collection needs MongoDB 6.0 or later',
      });
      if (
        (a.size !== '' && Number(a.size) < Number(b.size)) ||
        (a.max !== '' && (b.max === '' || Number(a.max) < Number(b.max)))
      ) {
        warnings.push({
          code: 'data-loss',
          message: 'A smaller capped collection removes its oldest documents to fit',
        });
      }
    }
    if (a.changeStreamImages !== b.changeStreamImages) {
      mod['changeStreamPreAndPostImages'] = { enabled: a.changeStreamImages };
      changes.push(
        `changeStreamPreAndPostImages: ${b.changeStreamImages ? 'on' : 'off'} → ${a.changeStreamImages ? 'on' : 'off'}`,
      );
    }
    if (changes.length > 0) {
      this.builder.add({
        ...base,
        id: `collection:${name}:alter`,
        kind: 'alter',
        steps: [
          step(PHASE.alterCollection, [command(mod)], {
            refs: [key.object(name)],
          }),
        ],
        changes,
        warnings,
        destructive: warnings.some((w) => w.code === 'data-loss'),
      });
    }
    this.diffIndexes(source, target);
  }

  diffIndexes(source: TableDef, target: TableDef): void {
    const collection = source.name;
    const sourceFields = new Map(source.indexes.map((i) => [i, indexFields(i, this.options)]));
    const targetFields = new Map(target.indexes.map((i) => [i, indexFields(i, this.options)]));
    const same = (s: IndexDef, t: IndexDef): boolean => {
      const x = sourceFields.get(s)!;
      const y = targetFields.get(t)!;
      if (x.keys !== y.keys || x.fields.size !== y.fields.size) return false;
      for (const [k, v] of x.fields) if (y.fields.get(k) !== v) return false;
      return true;
    };
    const pairs: { source?: IndexDef; target?: IndexDef }[] = [];
    const usedTargets = new Set<IndexDef>();
    if (this.options.ignoreNames) {
      for (const s of source.indexes) {
        const t = target.indexes.find((c) => !usedTargets.has(c) && same(s, c));
        if (t !== undefined) {
          usedTargets.add(t);
          pairs.push({ source: s, target: t });
        } else {
          pairs.push({ source: s });
        }
      }
    } else {
      const targets = byName(target.indexes);
      for (const s of source.indexes) {
        const t = targets.get(s.name);
        if (t !== undefined) usedTargets.add(t);
        pairs.push({ source: s, ...(t !== undefined ? { target: t } : {}) });
      }
    }
    for (const t of target.indexes) if (!usedTargets.has(t)) pairs.push({ target: t });

    for (const pair of pairs) {
      if (pair.source !== undefined && pair.target === undefined) {
        this.createIndex(collection, pair.source);
      } else if (pair.source === undefined && pair.target !== undefined) {
        this.dropIndex(collection, pair.target);
      } else if (pair.source !== undefined && pair.target !== undefined) {
        if (!same(pair.source, pair.target)) this.alterIndex(collection, pair.source, pair.target);
      }
    }
  }

  private indexBase(collection: string, index: IndexDef) {
    return {
      objectKind: 'index' as const,
      name: index.name,
      qualifiedName: `${collection}.${index.name}`,
      parent: collection,
    };
  }

  private createIndexStep(collection: string, index: IndexDef) {
    const { keys } = indexFields(index, this.options);
    return step(
      PHASE.createIndex,
      [command({ createIndexes: collection, indexes: [indexSpec(index)] })],
      {
        provides: [key.indexName(collection, index.name), key.indexKeys(collection, keys)],
        refs: [key.object(collection)],
      },
    );
  }

  private dropIndexStep(collection: string, index: IndexDef) {
    const { keys } = indexFields(index, this.options);
    return step(PHASE.dropIndex, [command({ dropIndexes: collection, index: index.name })], {
      removes: [key.indexName(collection, index.name), key.indexKeys(collection, keys)],
    });
  }

  private createIndex(collection: string, index: IndexDef): void {
    this.builder.add({
      ...this.indexBase(collection, index),
      id: `index:${collection}.${index.name}:create`,
      kind: 'create',
      steps: [this.createIndexStep(collection, index)],
      sourceDdl: indexDdl(collection, index),
      ...(index.unique
        ? {
            warnings: [
              {
                code: 'may-fail',
                message: 'Fails if documents in the target repeat the index key',
              },
            ],
          }
        : {}),
    });
  }

  private dropIndex(collection: string, index: IndexDef): void {
    this.builder.add({
      ...this.indexBase(collection, index),
      id: `index:${collection}.${index.name}:drop`,
      kind: 'drop',
      steps: [this.dropIndexStep(collection, index)],
      targetDdl: indexDdl(collection, index),
    });
  }

  private alterIndex(collection: string, source: IndexDef, target: IndexDef): void {
    const x = indexFields(source, this.options);
    const y = indexFields(target, this.options);
    const changed = new Set<string>();
    if (x.keys !== y.keys) changed.add('key');
    for (const name of new Set([...x.fields.keys(), ...y.fields.keys()])) {
      if (x.fields.get(name) !== y.fields.get(name)) changed.add(name);
    }
    const base = {
      ...this.indexBase(collection, source),
      id: `index:${collection}.${source.name}:alter`,
      kind: 'alter' as const,
      sourceDdl: indexDdl(collection, source),
      targetDdl: indexDdl(collection, target),
      changes: [...changed].map((name) =>
        name === 'key'
          ? 'key pattern'
          : name === 'name'
            ? `name: ${target.name} → ${source.name}`
            : name,
      ),
    };
    // Hiding and TTL changes are made in place; anything else drops and re-creates the index.
    const inPlace = [...changed].every(
      (name) => name === 'hidden' || name === 'expireAfterSeconds',
    );
    if (inPlace && source.name === target.name) {
      const spec = indexSpec(source);
      const change: BsonDocument = { name: source.name };
      if (changed.has('hidden')) change['hidden'] = spec['hidden'] === true;
      if (changed.has('expireAfterSeconds')) {
        const ttl = spec['expireAfterSeconds'];
        if (ttl !== undefined) change['expireAfterSeconds'] = ttl;
      }
      if (!changed.has('expireAfterSeconds') || spec['expireAfterSeconds'] !== undefined) {
        this.builder.add({
          ...base,
          steps: [
            step(PHASE.alterCollection, [command({ collMod: collection, index: change })], {
              refs: [key.object(collection)],
            }),
          ],
        });
        return;
      }
    }
    this.builder.add({
      ...base,
      steps: [this.dropIndexStep(collection, target), this.createIndexStep(collection, source)],
      warnings: [
        {
          code: 'info',
          message:
            'Dropped and re-created: queries that need the index scan the collection meanwhile',
        },
        ...(source.unique && !target.unique
          ? [
              {
                code: 'may-fail' as const,
                message: 'Fails if documents in the target repeat the index key',
              },
            ]
          : []),
      ],
    });
  }

  createView(view: ViewDef): void {
    const spec = viewSpec(view);
    this.builder.add({
      id: `view:${view.name}:create`,
      kind: 'create',
      objectKind: 'view',
      name: view.name,
      qualifiedName: view.name,
      steps: [
        step(PHASE.createView, [command({ create: view.name, ...spec })], {
          provides: [key.object(view.name)],
          refs: [key.object(String(spec['viewOn']))],
        }),
      ],
      sourceDdl: viewDdl(view),
    });
  }

  dropView(view: ViewDef): void {
    this.builder.add({
      id: `view:${view.name}:drop`,
      kind: 'drop',
      objectKind: 'view',
      name: view.name,
      qualifiedName: view.name,
      steps: [
        step(PHASE.dropView, [command({ drop: view.name })], { removes: [key.object(view.name)] }),
      ],
      targetDdl: viewDdl(view),
      destructive: true,
      warnings: [{ code: 'data-loss', message: 'Drops the view definition' }],
    });
  }

  alterView(source: ViewDef, target: ViewDef): void {
    const a = viewSpec(source);
    const b = viewSpec(target);
    const canon = (v: BsonValue | undefined): string =>
      v === undefined
        ? ''
        : canonicalBson(v, { ignoreFieldOrder: false, ignoreNumericTypes: true });
    const changes: string[] = [];
    if (a['viewOn'] !== b['viewOn'])
      changes.push(`viewOn: ${String(b['viewOn'])} → ${String(a['viewOn'])}`);
    if (canon(a['pipeline']) !== canon(b['pipeline'])) changes.push('pipeline');
    const collation =
      !this.options.ignoreCollation && canon(a['collation']) !== canon(b['collation']);
    if (changes.length === 0 && !collation) return;
    const base = {
      objectKind: 'view' as const,
      name: source.name,
      qualifiedName: source.name,
      sourceDdl: viewDdl(source),
      targetDdl: viewDdl(target),
    };
    if (collation) {
      // A view's collation is fixed when it is created.
      this.builder.add({
        ...base,
        id: `view:${source.name}:alter`,
        kind: 'alter',
        changes: [...changes, 'collation'],
        steps: [
          step(PHASE.dropView, [command({ drop: target.name })], {
            removes: [key.object(target.name)],
          }),
          step(PHASE.createView, [command({ create: source.name, ...a })], {
            provides: [key.object(source.name)],
            refs: [key.object(String(a['viewOn']))],
          }),
        ],
        warnings: [{ code: 'rebuild', message: 'Dropped and re-created to change its collation' }],
      });
      return;
    }
    this.builder.add({
      ...base,
      id: `view:${source.name}:alter`,
      kind: 'alter',
      changes,
      steps: [
        step(
          PHASE.alterView,
          [command({ collMod: source.name, viewOn: a['viewOn']!, pipeline: a['pipeline']! })],
          {
            refs: [key.object(String(a['viewOn']))],
          },
        ),
      ],
    });
  }
}

/**
 * Diffs two MongoDB database snapshots: the source is the desired state, the target the
 * database to change. The result is a SchemaDiff like the SQL engines', with `dialect`
 * 'mongodb' and command-document statements.
 */
export function diffMongoSchemas(
  source: SchemaSnapshot,
  target: SchemaSnapshot,
  options: CompareOptions = {},
): SchemaDiff {
  if (source.engine !== 'mongodb' || target.engine !== 'mongodb') {
    throw new QuerybaraError({
      code: 'NOT_SUPPORTED',
      message: `Cannot sync structure from ${source.engine} to ${target.engine}`,
      hint: 'MongoDB structure compares with another MongoDB database; move data between engines with data transfer instead.',
    });
  }
  const resolved = resolveCompareOptions(options);
  const s = onlyDatabase(source, 'source');
  const t = onlyDatabase(target, 'target');
  const diff = new MongoDiff(resolved);

  const targetTables = byName(t.tables);
  const sourceTables = byName(s.tables);
  for (const table of s.tables) {
    const other = targetTables.get(table.name);
    if (other === undefined) diff.createCollection(table);
    else diff.alterCollection(table, other);
  }
  for (const table of t.tables) if (!sourceTables.has(table.name)) diff.dropCollection(table);

  const targetViews = byName(t.views);
  const sourceViews = byName(s.views);
  for (const view of s.views) {
    const other = targetViews.get(view.name);
    if (other === undefined) diff.createView(view);
    else diff.alterView(view, other);
  }
  for (const view of t.views) if (!sourceViews.has(view.name)) diff.dropView(view);

  const { operations, order } = diff.builder.finish();
  const warnings: SyncWarning[] = [];
  if (resolved.ignoreNameCase) {
    warnings.push({
      code: 'info',
      message: 'MongoDB names are case-sensitive, so "ignore name case" does not apply',
    });
  }
  if (operations.length > 0) {
    warnings.push({
      code: 'non-transactional',
      message:
        'MongoDB runs these commands one by one: a failure part-way leaves the target partly changed',
    });
  }
  return {
    sourceEngine: source.engine,
    targetEngine: target.engine,
    dialect: 'mongodb',
    sourceDatabase: source.database,
    targetDatabase: target.database,
    operations,
    order,
    warnings,
    options: resolved,
    identical: operations.length === 0,
  };
}
