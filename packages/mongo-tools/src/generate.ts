import { QuerybaraError } from '@querybara/core';
import { Decimal128, Double, Int32, Long, ObjectId, UUID } from 'bson';

import { isBsonDocument, type BsonDocument, type BsonTypeName, type BsonValue } from './bson';
import type { SchemaAnalysis, SchemaField } from './schema';
import { parseShell } from './shell/parser';

/**
 * Studio 3T's Data Generator: documents made up from a rule per field, for test databases. A
 * rule names a dotted path (nested documents are made as needed) and a kind of value: an id, a
 * person's or a place's name, an email address, words, a number in a range, a date in a range,
 * one of a list, a constant. A field can be left out of a share of the documents, or hold an
 * array of values. A seeded random source makes the same seed give the same documents.
 *
 * Email addresses, web addresses and phone numbers use reserved names (example.com, 555).
 */

export const GENERATOR_KINDS = [
  'objectId',
  'uuid',
  'sequence',
  'firstName',
  'lastName',
  'fullName',
  'email',
  'phone',
  'company',
  'street',
  'city',
  'country',
  'zip',
  'url',
  'words',
  'sentence',
  'int',
  'long',
  'double',
  'decimal',
  'bool',
  'date',
  'pick',
  'constant',
  'null',
] as const;
export type GeneratorKind = (typeof GENERATOR_KINDS)[number];

export interface GeneratorRule {
  /** Dot notation: "address.city" makes `{ address: { city } }`. */
  readonly field: string;
  readonly kind: GeneratorKind;
  /**
   * The range of `int`, `long`, `double` and `decimal`; the word count of `words` and
   * `sentence`; `sequence` starts at `min` and steps by `max` (1 when unset).
   */
  readonly min?: number;
  readonly max?: number;
  /** Digits after the point for `double` and `decimal` (2 when unset). */
  readonly decimals?: number;
  /** The range of `date`, as ISO dates (the last five years to now when unset). */
  readonly from?: string;
  readonly to?: string;
  /** `pick`: an array in mongosh syntax; `constant`: a value in mongosh syntax. */
  readonly values?: string;
  /** `bool`: the percentage of true values (50 when unset). */
  readonly trueShare?: number;
  /** The percentage of documents without the field. */
  readonly missing?: number;
  /** An array of this many values, from `arrayMin` to `arrayMax`, instead of one value. */
  readonly arrayMin?: number;
  readonly arrayMax?: number;
}

export interface GenerateOptions {
  readonly count: number;
  /** The random source's seed; the same seed gives the same documents. */
  readonly seed?: number;
  /** The index of the first document, for `sequence` across batches. */
  readonly start?: number;
  /** The clock for the default date range. */
  readonly now?: Date;
}

/** A small, fast, seeded source of random numbers (mulberry32). */
export class SeededRandom {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0;
  }

  /** A number in [0, 1). */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  }

  /** A whole number in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }
}

/** Comma-separated names, one list per kind. */
function list(text: string): readonly string[] {
  return text
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

const FIRST_NAMES = list(`
  Ada, Alan, Amara, Ana, Arjun, Ben, Carla, Chen, Daniel, Elena, Emma, Farah, Felix, Grace, Hana,
  Hugo, Ines, Ivan, Jamal, Julia, Kenji, Lara, Leo, Lina, Luca, Maya, Mateo, Mei, Nadia, Noah,
  Olga, Omar, Priya, Rafael, Rosa, Sam, Sofia, Tariq, Vera, Yusuf, Zoe
`);
const LAST_NAMES = list(`
  Adams, Alvarez, Bauer, Becker, Chen, Costa, Diaz, Dubois, Evans, Fischer, Garcia, Hansen, Ito,
  Jensen, Kim, Kowalski, Lopez, Martin, Meyer, Moreau, Nakamura, Novak, Okafor, Olsen, Patel,
  Petrov, Rossi, Santos, Schmidt, Silva, Singh, Smith, Tanaka, Thomas, Weber, Wilson, Yilmaz,
  Zhang
`);
const CITIES = list(`
  Amsterdam, Athens, Austin, Barcelona, Berlin, Bogotá, Boston, Cairo, Cape Town, Chicago,
  Dublin, Helsinki, Istanbul, Kraków, Lagos, Lima, Lisbon, London, Lyon, Madrid, Melbourne,
  Mexico City, Montreal, Mumbai, Nairobi, Osaka, Oslo, Paris, Prague, Rome, São Paulo, Seoul,
  Singapore, Stockholm, Sydney, Tokyo, Toronto, Vienna, Warsaw, Zürich
`);
const COUNTRIES = list(`
  Argentina, Australia, Austria, Brazil, Canada, Chile, Colombia, Denmark, Egypt, Finland,
  France, Germany, Greece, India, Ireland, Italy, Japan, Kenya, Mexico, Netherlands, New Zealand,
  Nigeria, Norway, Peru, Poland, Portugal, Singapore, South Africa, South Korea, Spain, Sweden,
  Switzerland, Turkey, United Kingdom, United States
`);
const STREETS = list(`
  Acacia, Birch, Cedar, Church, Elm, Highland, Hill, Lake, Maple, Meadow, Mill, Oak, Park, Pine,
  River, Station, Sunset, Valley, Willow, Windsor
`);
const STREET_TYPES = ['Street', 'Avenue', 'Road', 'Lane', 'Way', 'Drive', 'Place', 'Court'];
const COMPANY_SUFFIXES = ['Inc', 'LLC', 'Group', 'Labs', 'Partners', 'Systems', 'Studio', 'Co'];
const EMAIL_DOMAINS = ['example.com', 'example.net', 'example.org'];
const WORDS = list(`
  alpha, amber, anchor, apple, arrow, atlas, beacon, birch, blue, bright, canyon, cedar, cloud,
  comet, copper, coral, delta, drift, echo, ember, falcon, fern, field, flint, forest, frost,
  garden, glade, harbor, hazel, island, ivory, jade, lake, lantern, maple, meadow, mist, north,
  ocean, orchid, pebble, pine, quartz, raven, river, saffron, silver, spring, stone, summit,
  thistle, tide, valley, willow, winter
`);

const YEAR_MS = 365.25 * 86_400_000;

function invalid(rule: GeneratorRule, why: string): QuerybaraError {
  return new QuerybaraError({
    code: 'VALIDATION_FAILED',
    message: `${rule.field || 'A rule'}: ${why}`,
  });
}

/** ASCII letters of a name, for email and web addresses. */
function slug(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[^A-Za-z]/g, '')
    .toLowerCase();
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function integerOf(n: number): BsonValue {
  return n >= -2_147_483_648 && n <= 2_147_483_647 ? new Int32(n) : Long.fromNumber(n);
}

/** One rule made ready: checked, its constants parsed. */
interface Compiled {
  readonly rule: GeneratorRule;
  readonly path: readonly string[];
  readonly value: (random: SeededRandom, index: number) => BsonValue;
}

function compileRule(rule: GeneratorRule, now: Date): Compiled {
  const field = rule.field.trim();
  if (field === '') throw invalid(rule, 'name the field');
  const path = field.split('.');
  if (path.some((part) => part === '' || part.startsWith('$'))) {
    throw invalid(rule, 'is not a field path');
  }
  const min = rule.min;
  const max = rule.max;
  const range = (low: number, high: number): readonly [number, number] => {
    const a = min ?? low;
    const b = max ?? high;
    if (!Number.isFinite(a) || !Number.isFinite(b))
      throw invalid(rule, 'give the range as numbers');
    if (a > b) throw invalid(rule, `the range starts above its end (${a} > ${b})`);
    return [a, b];
  };
  const decimals = Math.min(Math.max(Math.trunc(rule.decimals ?? 2), 0), 12);
  const words = (random: SeededRandom): string[] => {
    const [low, high] = range(3, 8);
    return Array.from({ length: random.int(Math.max(1, low), Math.max(1, high)) }, () =>
      random.pick(WORDS),
    );
  };
  const person = (random: SeededRandom) => ({
    first: random.pick(FIRST_NAMES),
    last: random.pick(LAST_NAMES),
  });
  let value: Compiled['value'];
  switch (rule.kind) {
    case 'objectId':
      value = (random) => {
        const bytes = new Uint8Array(12);
        const seconds = Math.floor(now.getTime() / 1000) - random.int(0, 5 * 365 * 86_400);
        new DataView(bytes.buffer).setUint32(0, seconds);
        for (let i = 4; i < 12; i++) bytes[i] = random.int(0, 255);
        return new ObjectId(bytes);
      };
      break;
    case 'uuid':
      value = (random) => {
        const bytes = new Uint8Array(16);
        for (let i = 0; i < 16; i++) bytes[i] = random.int(0, 255);
        bytes[6] = (bytes[6]! & 0x0f) | 0x40;
        bytes[8] = (bytes[8]! & 0x3f) | 0x80;
        return new UUID(bytes);
      };
      break;
    case 'sequence': {
      const start = min ?? 1;
      const step = max ?? 1;
      if (!Number.isInteger(start) || !Number.isInteger(step)) {
        throw invalid(rule, 'a sequence starts and steps by whole numbers');
      }
      value = (_random, index) => integerOf(start + index * step);
      break;
    }
    case 'firstName':
      value = (random) => random.pick(FIRST_NAMES);
      break;
    case 'lastName':
      value = (random) => random.pick(LAST_NAMES);
      break;
    case 'fullName':
      value = (random) => {
        const { first, last } = person(random);
        return `${first} ${last}`;
      };
      break;
    case 'email':
      value = (random) => {
        const { first, last } = person(random);
        return `${slug(first)}.${slug(last)}${random.int(1, 999)}@${random.pick(EMAIL_DOMAINS)}`;
      };
      break;
    case 'phone':
      value = (random) =>
        `+1-${random.int(201, 989)}-555-${String(random.int(0, 9999)).padStart(4, '0')}`;
      break;
    case 'company':
      value = (random) => `${random.pick(LAST_NAMES)} ${random.pick(COMPANY_SUFFIXES)}`;
      break;
    case 'street':
      value = (random) =>
        `${random.int(1, 999)} ${random.pick(STREETS)} ${random.pick(STREET_TYPES)}`;
      break;
    case 'city':
      value = (random) => random.pick(CITIES);
      break;
    case 'country':
      value = (random) => random.pick(COUNTRIES);
      break;
    case 'zip':
      value = (random) => String(random.int(10_000, 99_999));
      break;
    case 'url':
      value = (random) => `https://${random.pick(WORDS)}-${random.pick(WORDS)}.example.com/`;
      break;
    case 'words':
      range(3, 8);
      value = (random) => words(random).join(' ');
      break;
    case 'sentence':
      range(3, 8);
      value = (random) => `${capitalise(words(random).join(' '))}.`;
      break;
    case 'int':
    case 'long': {
      const [low, high] = range(0, 1000);
      const kind = rule.kind;
      value = (random) => {
        const n = random.int(Math.ceil(low), Math.floor(high));
        return kind === 'long' ? Long.fromNumber(n) : integerOf(n);
      };
      break;
    }
    case 'double':
    case 'decimal': {
      const [low, high] = range(0, 1000);
      const kind = rule.kind;
      value = (random) => {
        const text = (low + random.next() * (high - low)).toFixed(decimals);
        return kind === 'decimal' ? Decimal128.fromString(text) : new Double(Number(text));
      };
      break;
    }
    case 'bool': {
      const share = (rule.trueShare ?? 50) / 100;
      value = (random) => random.next() < share;
      break;
    }
    case 'date': {
      const from = rule.from ? Date.parse(rule.from) : now.getTime() - 5 * YEAR_MS;
      const to = rule.to ? Date.parse(rule.to) : now.getTime();
      if (Number.isNaN(from) || Number.isNaN(to))
        throw invalid(rule, 'give the dates as ISO dates');
      if (from > to) throw invalid(rule, 'the dates start after they end');
      value = (random) => new Date(Math.floor(from + random.next() * (to - from)));
      break;
    }
    case 'pick': {
      let items: BsonValue;
      try {
        items = parseShell(rule.values ?? '');
      } catch (error) {
        throw invalid(rule, `the values do not parse (${(error as Error).message})`);
      }
      if (!Array.isArray(items) || items.length === 0) {
        throw invalid(rule, "list the values as an array, e.g. ['A', 'B']");
      }
      const list = items;
      value = (random) => random.pick(list);
      break;
    }
    case 'constant': {
      let constant: BsonValue;
      try {
        constant = parseShell(rule.values ?? '');
      } catch (error) {
        throw invalid(rule, `the value does not parse (${(error as Error).message})`);
      }
      value = () => constant;
      break;
    }
    case 'null':
      value = () => null;
      break;
  }
  const arrayMin = rule.arrayMin;
  const arrayMax = rule.arrayMax ?? arrayMin;
  if (arrayMax !== undefined) {
    const low = Math.max(0, Math.trunc(arrayMin ?? 0));
    const high = Math.trunc(arrayMax);
    if (high < low) throw invalid(rule, 'the array length starts above its end');
    const one = value;
    value = (random, index) =>
      Array.from({ length: random.int(low, high) }, () => one(random, index));
  }
  return { rule, path, value };
}

/** Checks the rules and makes a function that builds the document of an index. */
export function compileGenerator(
  rules: readonly GeneratorRule[],
  now: Date = new Date(),
): (random: SeededRandom, index: number) => BsonDocument {
  const compiled = rules.map((rule) => compileRule(rule, now));
  const fields = compiled.map((c) => c.path.join('.'));
  fields.forEach((field, i) => {
    const clash = fields.find(
      (other, j) => j !== i && (other === field || other.startsWith(`${field}.`)),
    );
    if (clash !== undefined) {
      throw new QuerybaraError({
        code: 'VALIDATION_FAILED',
        message:
          clash === field
            ? `${field}: two rules make this field`
            : `${field}: ${clash} is made inside it, so it cannot hold a value of its own`,
      });
    }
  });
  return (random, index) => {
    const doc: BsonDocument = {};
    for (const { rule, path, value } of compiled) {
      // Drawn either way, so a field's values do not depend on the others' missing shares.
      const skip = random.next() * 100 < (rule.missing ?? 0);
      const made = value(random, index);
      if (skip) continue;
      let target = doc;
      for (const part of path.slice(0, -1)) {
        const next = target[part];
        if (!isBsonDocument(next)) target[part] = {};
        target = target[part] as BsonDocument;
      }
      target[path[path.length - 1]!] = made;
    }
    return doc;
  };
}

/** `count` documents from the rules, from index `start` (0 when unset). */
export function generateDocuments(
  rules: readonly GeneratorRule[],
  options: GenerateOptions,
): BsonDocument[] {
  const start = options.start ?? 0;
  const make = compileGenerator(rules, options.now);
  // Each document draws from its own seed, so a batch starting at `start` repeats exactly.
  const seed = options.seed ?? Math.floor(Math.random() * 4_294_967_296);
  return Array.from({ length: options.count }, (_, i) =>
    make(new SeededRandom(seed + Math.imul(start + i, 0x9e3779b1)), start + i),
  );
}

/** The kind a field's name and type suggest. */
function guessKind(name: string, type: BsonTypeName | undefined): GeneratorKind {
  const n = name.toLowerCase().replace(/[^a-z]/g, '');
  if (type === 'objectId') return 'objectId';
  if (type === 'uuid') return 'uuid';
  if (type === 'bool') return 'bool';
  if (type === 'date' || type === 'timestamp') return 'date';
  if (type === 'int') return 'int';
  if (type === 'long') return 'long';
  if (type === 'double') return 'double';
  if (type === 'decimal') return 'decimal';
  if (type === 'null') return 'null';
  if (type !== undefined && type !== 'string') return 'null';
  if (n.includes('email') || n.includes('mail')) return 'email';
  if (n.includes('phone') || n.includes('mobile') || n === 'tel') return 'phone';
  if (n === 'firstname' || n === 'givenname' || n === 'first') return 'firstName';
  if (n === 'lastname' || n === 'surname' || n === 'familyname' || n === 'last') return 'lastName';
  if (n.endsWith('name') && (n.includes('company') || n.includes('org'))) return 'company';
  if (n === 'company' || n === 'organisation' || n === 'organization' || n === 'employer') {
    return 'company';
  }
  if (n === 'name' || n === 'fullname' || n === 'customer' || n === 'author') return 'fullName';
  if (n.includes('street') || n === 'address' || n === 'addressline') return 'street';
  if (n === 'city' || n === 'town') return 'city';
  if (n === 'country') return 'country';
  if (n.includes('zip') || n.includes('postal') || n === 'postcode') return 'zip';
  if (n.includes('url') || n.includes('website') || n === 'link' || n === 'homepage') return 'url';
  if (n.includes('description') || n.includes('comment') || n === 'notes' || n === 'bio') {
    return 'sentence';
  }
  return 'words';
}

/**
 * A rule per field of a schema sample: the kind the field's most common type and its name
 * suggest, a numeric range from the values seen, and the share of documents without it.
 * Arrays and embedded documents give rules for what is inside them.
 */
export function defaultGeneratorRules(analysis: SchemaAnalysis): GeneratorRule[] {
  // A document's fields get rules; the document itself is made from them.
  const leaves: SchemaField[] = [];
  const walk = (fields: readonly SchemaField[]): void => {
    for (const field of fields) {
      if (field.fields.length > 0) walk(field.fields);
      else leaves.push(field);
    }
  };
  walk(analysis.fields);
  const rules: GeneratorRule[] = [];
  for (const field of leaves) {
    const path = field.queryPath;
    const type = field.types.find((t) => t.type !== 'null')?.type ?? field.types[0]?.type;
    const kind = guessKind(field.name, type);
    const rule: { -readonly [K in keyof GeneratorRule]: GeneratorRule[K] } = { field: path, kind };
    if (kind === 'int' || kind === 'long' || kind === 'double' || kind === 'decimal') {
      const numbers = field.topValues
        .map((value) => Number(parseValue(value.value)))
        .filter((n) => Number.isFinite(n));
      if (numbers.length > 1) {
        rule.min = Math.min(...numbers);
        rule.max = Math.max(...numbers);
      }
    }
    if (kind === 'words' && field.topValuesExact && field.topValues.length > 0) {
      // A field with few distinct values (a status, a category) picks among them.
      if (field.topValues.length <= 10) {
        rule.kind = 'pick';
        rule.values = `[${field.topValues.map((value) => value.display).join(', ')}]`;
      }
    }
    if (type === 'array') {
      // An array of what its elements are, as long as the sample's arrays.
      const items = field.items;
      const itemType = items?.types.find((t) => t.type !== 'null')?.type;
      rule.kind =
        itemType === undefined || itemType === 'object' || itemType === 'array'
          ? 'words'
          : guessKind(field.name.replace(/s$/, ''), itemType);
      rule.arrayMin = field.arrayLengths?.min ?? 0;
      rule.arrayMax = Math.max(rule.arrayMin, field.arrayLengths?.max ?? 3);
      if (rule.kind === 'words') {
        rule.min = 1;
        rule.max = 1;
      }
    }
    const missing = Math.round((1 - field.share) * 100);
    if (path !== '_id' && missing > 0) rule.missing = missing;
    rules.push(rule);
  }
  return rules;
}

function parseValue(ejson: string): unknown {
  try {
    const parsed = JSON.parse(ejson) as unknown;
    if (typeof parsed === 'number') return parsed;
    if (parsed !== null && typeof parsed === 'object') {
      const wrapped = Object.values(parsed)[0];
      return typeof wrapped === 'string' ? Number(wrapped) : wrapped;
    }
    return parsed;
  } catch {
    return undefined;
  }
}
