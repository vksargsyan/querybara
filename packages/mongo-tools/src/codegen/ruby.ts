import type { BsonDocument, BsonValue } from '../bson';
import { formatDouble } from '../shell/format';
import {
  URI_EXAMPLE,
  URI_VARIABLE,
  classify,
  dateParts,
  hasContent,
  hex4,
  layoutList,
  quoteString,
  type ExportTarget,
} from './common';

/**
 * Ruby for the `mongo` gem (Studio 3T's Query Code languages, ADR 0036). Hashes keep their key
 * order, so documents are hash literals with string keys; Ruby Integers are written as Int32
 * when they fit, so an Int64 is spelled `BSON::Int64.new`, and a whole Double keeps its `.0`.
 */

/** A Ruby double-quoted string literal (`#` escaped, so nothing interpolates). */
export function quoteRuby(value: string): string {
  return quoteString(
    value,
    '"',
    { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t', '#': '\\#' },
    (code) => `\\u${hex4(code)}`,
  );
}

const BINARY_SUBTYPES: Readonly<Record<number, string>> = {
  0: ':generic',
  1: ':function',
  2: ':old',
  3: ':uuid_old',
  4: ':uuid',
  5: ':md5',
  6: ':ciphertext',
  7: ':column',
  8: ':sensitive',
  9: ':vector',
  128: ':user',
};

function hexBytes(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Ruby values for the `mongo` gem (bson-ruby types). */
export class RubyValues {
  private readonly indent = '  ';

  value(value: BsonValue, level: number, used = 0): string {
    const v = classify(value);
    switch (v.type) {
      case 'null':
        return 'nil';
      case 'bool':
        return v.value ? 'true' : 'false';
      case 'string':
        return quoteRuby(v.value);
      case 'symbol':
        return `BSON::Symbol::Raw.new(${quoteRuby(v.value)})`;
      case 'int32':
        return String(v.value);
      case 'int64':
        return `BSON::Int64.new(${v.value})`;
      case 'double':
        if (Number.isNaN(v.value)) return 'Float::NAN';
        if (v.value === Infinity) return 'Float::INFINITY';
        if (v.value === -Infinity) return '-Float::INFINITY';
        return formatDouble(v.value);
      case 'decimal':
        return `BSON::Decimal128.new("${v.value}")`;
      case 'objectId':
        return `BSON::ObjectId.from_string("${v.hex}")`;
      case 'date': {
        const p = dateParts(v.date);
        if (p.year < 1 || p.year > 9999) return `Time.at(0, ${v.date.getTime()}, :millisecond).utc`;
        const parts = [p.year, p.month, p.day, p.hour, p.minute, p.second];
        if (p.millisecond > 0) parts.push(p.millisecond * 1000);
        while (parts.length > 3 && parts[parts.length - 1] === 0) parts.pop();
        return `Time.utc(${parts.join(', ')})`;
      }
      case 'binary': {
        const subtype =
          BINARY_SUBTYPES[v.subtype] ?? `"\\x${v.subtype.toString(16).padStart(2, '0')}".b`;
        return `BSON::Binary.new(["${hexBytes(v.bytes)}"].pack("H*"), ${subtype})`;
      }
      case 'uuid':
        return `BSON::Binary.from_uuid("${v.uuid}")`;
      case 'regex':
        return `BSON::Regexp::Raw.new(${quoteRuby(v.pattern)}, "${v.flags}")`;
      case 'timestamp':
        return `BSON::Timestamp.new(${v.t}, ${v.i})`;
      case 'minKey':
        return 'BSON::MinKey.new';
      case 'maxKey':
        return 'BSON::MaxKey.new';
      case 'code':
        return v.scope === undefined
          ? `BSON::Code.new(${quoteRuby(v.code)})`
          : `BSON::CodeWithScope.new(${quoteRuby(v.code)}, ${this.value(v.scope, level, used)})`;
      case 'dbref': {
        const fields = [
          `"$ref" => ${quoteRuby(v.collection)}`,
          `"$id" => ${this.value(v.id, level + 1)}`,
          ...(v.db !== undefined ? [`"$db" => ${quoteRuby(v.db)}`] : []),
        ];
        return `BSON::DBRef.new({ ${fields.join(', ')} })`;
      }
      case 'array':
        return layoutList(
          v.items.map((item) => this.value(item, level + 1)),
          { open: '[', close: ']', trailingComma: true },
          this.indent,
          level,
          used,
        );
      case 'document':
        return layoutList(
          v.entries.map(([key, item]) => {
            const prefix = `${quoteRuby(key)} => `;
            return prefix + this.value(item, level + 1, prefix.length);
          }),
          { open: '{', close: '}', pad: true, trailingComma: true },
          this.indent,
          level,
          used,
        );
    }
  }

  document(doc: BsonDocument, level: number, used = 0): string {
    return this.value(doc, level, used);
  }
}

/** A complete Ruby script that runs the query with the `mongo` gem. */
export function rubyProgram(target: ExportTarget, database: string): string {
  const values = new RubyValues();
  const body: string[] = [];
  const assign = (name: string, text: string): void => {
    body.push(`${name} = ${text}`);
  };
  let call: string;
  if (target.kind === 'find') {
    const { query } = target;
    assign('filter', values.document(query.filter, 0, 'filter = '.length));
    const options: string[] = [];
    if (hasContent(query.projection)) {
      options.push(`projection: ${values.document(query.projection, 1, 12)}`);
    }
    if (hasContent(query.sort)) options.push(`sort: ${values.document(query.sort, 1, 6)}`);
    if (query.skip !== undefined && query.skip > 0) options.push(`skip: ${query.skip}`);
    if (query.limit !== undefined && query.limit > 0) options.push(`limit: ${query.limit}`);
    if (hasContent(query.collation)) {
      options.push(`collation: ${values.document(query.collation, 1, 11)}`);
    }
    if (query.hint !== undefined) {
      options.push(
        `hint: ${typeof query.hint === 'string' ? quoteRuby(query.hint) : values.document(query.hint, 1, 6)}`,
      );
    }
    if (query.maxTimeMS !== undefined) options.push(`max_time_ms: ${query.maxTimeMS}`);
    call =
      options.length === 0
        ? 'collection.find(filter)'
        : layoutList(['filter', ...options], { open: 'collection.find(', close: ')' }, '  ', 0, 0);
  } else {
    assign('pipeline', values.value([...target.pipeline], 0, 'pipeline = '.length));
    call = 'collection.aggregate(pipeline)';
  }
  return `# gem install mongo
# Set ${URI_VARIABLE} to your connection string, e.g. ${URI_EXAMPLE}
require "mongo"

client = Mongo::Client.new(ENV.fetch("${URI_VARIABLE}"), database: ${quoteRuby(database)})
collection = client[${quoteRuby(target.collection)}]
${body.join('\n')}
${call}.each do |document|
  puts document
end
client.close
`;
}
