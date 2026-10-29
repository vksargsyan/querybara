import { fromEjson, isBsonDocument, toEjson } from './bson';
import type { IndexInfo, IndexSpec } from './wire';

/**
 * The spec that creates the same index on another collection, from how an index is listed
 * (ADR 0036: Duplicate Collection; transfers between MongoDB connections). A text index lists
 * its internal keys (`_fts`, `_ftsx`); it is recreated from its weights.
 */
export function indexSpecOf(info: IndexInfo): IndexSpec {
  let keys = info.keys;
  let text: Pick<IndexSpec, 'weights' | 'defaultLanguage' | 'languageOverride'> = {};
  if (info.kind === 'text') {
    const spec = fromEjson(info.spec, 'index');
    const weights = isBsonDocument(spec) ? spec['weights'] : undefined;
    if (isBsonDocument(weights)) {
      keys = toEjson(Object.fromEntries(Object.keys(weights).map((field) => [field, 'text'])));
      const language = isBsonDocument(spec) ? spec['default_language'] : undefined;
      const override = isBsonDocument(spec) ? spec['language_override'] : undefined;
      text = {
        weights: toEjson(weights),
        ...(typeof language === 'string' ? { defaultLanguage: language } : {}),
        ...(typeof override === 'string' ? { languageOverride: override } : {}),
      };
    }
  }
  return {
    keys,
    name: info.name,
    ...(info.unique ? { unique: true } : {}),
    ...(info.sparse ? { sparse: true } : {}),
    ...(info.hidden ? { hidden: true } : {}),
    ...(info.expireAfterSeconds !== undefined
      ? { expireAfterSeconds: info.expireAfterSeconds }
      : {}),
    ...(info.partialFilterExpression !== undefined
      ? { partialFilterExpression: info.partialFilterExpression }
      : {}),
    ...(info.collation !== undefined ? { collation: info.collation } : {}),
    ...(info.wildcardProjection !== undefined
      ? { wildcardProjection: info.wildcardProjection }
      : {}),
    ...text,
  };
}

/** Indexes a copy of a collection gets: all but `_id_` and a clustered collection's key. */
export function copiedIndexes(indexes: readonly IndexInfo[]): IndexSpec[] {
  return indexes
    .filter((index) => index.name !== '_id_' && index.kind !== 'clustered')
    .map(indexSpecOf);
}
