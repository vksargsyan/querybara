import {
  defaultGeneratorRules,
  generateDocuments,
  toEjson,
  type GeneratorRule,
  type Namespace,
} from '@querybara/mongo-tools';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

import { errorMessage } from '../../lib/errors';
import { confirm } from '../dialogs';
import { patchPanel } from '../panels';
import { SessionLane } from '../session-lane';
import { namespaceReference } from './explorer';
import { DocumentResults } from './results';
import { DEFAULT_WRITE_RULES, loadWriteRules, type WriteRules } from './write-rules';

/**
 * Studio 3T's Data Generator: test documents made up from a rule per field (a name, an email
 * address, a number in a range, one of a list...), read at first from a sample of the
 * collection. A preview shows the first documents; Generate inserts them in batches, after a
 * confirmation, adding to the collection or replacing what it holds. The seed is shown, so the
 * same documents can be made again.
 */

export interface DataGeneratorTarget {
  readonly profileId: string;
  readonly db: string;
  readonly collection: string;
}

/** A rule as the panel edits it: the generator's rule plus a row id. */
export interface GeneratorRow extends GeneratorRule {
  readonly id: number;
}

export type GenerateMode = 'append' | 'replace';

export interface DataGeneratorState {
  readonly rules: readonly GeneratorRow[];
  /** Typed, so a half-typed number stays as it is. */
  readonly count: string;
  readonly seed: string;
  readonly mode: GenerateMode;
  readonly scanning: boolean;
  readonly previewing: boolean;
  /** Documents inserted so far while generating. */
  readonly progress: { readonly done: number; readonly total: number } | undefined;
  readonly writeRules: WriteRules;
  readonly notice: { readonly kind: 'success' | 'error'; readonly text: string } | undefined;
}

export const GENERATOR_KIND_LABELS: Readonly<Record<GeneratorRule['kind'], string>> = {
  objectId: 'ObjectId',
  uuid: 'UUID',
  sequence: 'Sequence',
  firstName: 'First name',
  lastName: 'Last name',
  fullName: 'Full name',
  email: 'Email address',
  phone: 'Phone number',
  company: 'Company',
  street: 'Street address',
  city: 'City',
  country: 'Country',
  zip: 'Postal code',
  url: 'Web address',
  words: 'Words',
  sentence: 'Sentence',
  int: 'Int32 in a range',
  long: 'Int64 in a range',
  double: 'Double in a range',
  decimal: 'Decimal128 in a range',
  bool: 'Boolean',
  date: 'Date in a range',
  pick: 'One of a list',
  constant: 'Constant',
  null: 'Null',
};

/** Documents per insertMany. */
export const GENERATE_BATCH = 500;
/** The most documents one run makes. */
export const GENERATE_MAX = 1_000_000;
const PREVIEW = 10;

function randomSeed(): string {
  return String(Math.floor(Math.random() * 1_000_000_000));
}

export class DataGenerator {
  readonly id: string;
  readonly target: DataGeneratorTarget;
  readonly store: StoreApi<DataGeneratorState>;
  /** The first documents the rules make. */
  readonly preview = new DocumentResults({ mode: 'json' });
  readonly #lane: SessionLane;
  #nextId = 1;
  #cancelled = false;

  constructor(id: string, target: DataGeneratorTarget) {
    this.id = id;
    this.target = target;
    this.store = createStore<DataGeneratorState>()(() => ({
      rules: [],
      count: '1000',
      seed: randomSeed(),
      mode: 'append',
      scanning: false,
      previewing: false,
      progress: undefined,
      writeRules: DEFAULT_WRITE_RULES,
      notice: undefined,
    }));
    this.#lane = new SessionLane(target.profileId, target.db);
  }

  get state(): DataGeneratorState {
    return this.store.getState();
  }

  get ns(): Namespace {
    return { db: this.target.db, collection: this.target.collection };
  }

  #set(patch: Partial<DataGeneratorState>): void {
    this.store.setState(patch);
  }

  async init(): Promise<void> {
    this.#set({ writeRules: await loadWriteRules(this.target.profileId) });
    await this.scan();
  }

  /** Reads the collection's fields from a sample, a rule each; an empty one starts with an id. */
  async scan(): Promise<void> {
    this.#set({ scanning: true, notice: undefined });
    try {
      const analysis = await this.#lane.run((host, sessionId) =>
        host.mongo.analyzeSchema({ sessionId, ns: this.ns, options: { sampleSize: 1000 } }),
      );
      const rules: GeneratorRule[] =
        analysis.documentCount === 0
          ? [
              { field: '_id', kind: 'objectId' },
              { field: 'name', kind: 'fullName' },
              { field: 'email', kind: 'email' },
            ]
          : defaultGeneratorRules(analysis);
      this.#set({ rules: rules.map((rule) => ({ ...rule, id: this.#nextId++ })) });
      void this.refreshPreview();
    } catch (error) {
      this.#set({ notice: { kind: 'error', text: `Fields: ${errorMessage(error)}` } });
    } finally {
      this.#set({ scanning: false });
    }
  }

  setRule(id: number, patch: Partial<GeneratorRule>): void {
    this.#set({
      rules: this.state.rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)),
    });
  }

  addRule(): void {
    this.#set({
      rules: [...this.state.rules, { id: this.#nextId++, field: '', kind: 'words' }],
    });
  }

  removeRule(id: number): void {
    this.#set({ rules: this.state.rules.filter((rule) => rule.id !== id) });
  }

  setCount(count: string): void {
    this.#set({ count });
  }

  setSeed(seed: string): void {
    this.#set({ seed });
  }

  newSeed(): void {
    this.#set({ seed: randomSeed() });
    void this.refreshPreview();
  }

  setMode(mode: GenerateMode): void {
    this.#set({ mode });
  }

  #rules(): GeneratorRule[] {
    return this.state.rules.map(({ id: _id, ...rule }) => rule);
  }

  /** The number of documents to make, or why it is not one. */
  countOf(): number | string {
    const count = Number(this.state.count.trim());
    if (!Number.isInteger(count) || count < 1) return 'Enter how many documents to make';
    if (count > GENERATE_MAX) return `Make at most ${GENERATE_MAX.toLocaleString()} at a time`;
    return count;
  }

  #seed(): number {
    const seed = Number(this.state.seed.trim());
    return Number.isInteger(seed) && seed >= 0 ? seed : 0;
  }

  /** The first documents the rules make with this seed, the same ones Generate starts with. */
  async refreshPreview(): Promise<void> {
    this.#set({ previewing: true });
    this.preview.begin(undefined, [], 0);
    try {
      const docs = generateDocuments(this.#rules(), { count: PREVIEW, seed: this.#seed() });
      this.preview.append(
        docs.map((doc) => toEjson(doc)),
        false,
      );
      this.#set({ notice: undefined });
    } catch (error) {
      this.preview.fail(errorMessage(error));
    } finally {
      this.#set({ previewing: false });
    }
  }

  /** Inserts the documents in batches, after the confirmation; true when all went in. */
  async generate(): Promise<boolean> {
    const { writeRules, mode } = this.state;
    if (writeRules.readOnlyProfile) {
      this.#set({ notice: { kind: 'error', text: 'This connection is read-only.' } });
      return false;
    }
    const count = this.countOf();
    if (typeof count === 'string') {
      this.#set({ notice: { kind: 'error', text: count } });
      return false;
    }
    const rules = this.#rules();
    const seed = this.#seed();
    try {
      generateDocuments(rules, { count: 1, seed });
    } catch (error) {
      this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
      return false;
    }
    const where = namespaceReference(this.target.db, this.target.collection);
    const documents = count === 1 ? 'a document' : `${count.toLocaleString()} documents`;
    const replace = mode === 'replace';
    const ok = await confirm({
      title: `Generate ${documents} in ${this.target.collection}?`,
      message: `${replace ? `Every document ${this.target.collection} holds is deleted first, then the new ones are inserted` : 'The new documents are added to what the collection holds'}, in batches of ${GENERATE_BATCH}${writeRules.production ? ', on this production connection' : ''}. This runs:`,
      detail: `${replace ? `${where}.deleteMany({})\n` : ''}${where}.insertMany([ … ${count} … ])`,
      confirmLabel: replace ? 'Delete and generate' : 'Generate',
      danger: replace || writeRules.production,
    });
    if (!ok) return false;
    this.#cancelled = false;
    this.#set({ progress: { done: 0, total: count }, notice: undefined });
    patchPanel(this.id, { busy: true });
    let done = 0;
    try {
      if (replace) {
        await this.#lane.run((host, sessionId) =>
          host.mongo.deleteMany({ sessionId, ns: this.ns, filter: '{}', confirmed: true }),
        );
      }
      while (done < count && !this.#cancelled) {
        const batch = generateDocuments(rules, {
          count: Math.min(GENERATE_BATCH, count - done),
          seed,
          start: done,
        });
        const result = await this.#lane.run((host, sessionId) =>
          host.mongo.insertMany({
            sessionId,
            ns: this.ns,
            documents: toEjson(batch),
            ordered: true,
            confirmed: true,
          }),
        );
        done += result.insertedCount;
        this.#set({ progress: { done, total: count } });
      }
      const stopped = this.#cancelled;
      this.#set({
        notice: {
          kind: 'success',
          text: `${stopped ? 'Stopped: ' : ''}${done.toLocaleString()} ${done === 1 ? 'document' : 'documents'} inserted into ${this.target.collection}.`,
        },
      });
      return !stopped;
    } catch (error) {
      this.#set({
        notice: {
          kind: 'error',
          text: `${done.toLocaleString()} inserted, then: ${errorMessage(error)}`,
        },
      });
      return false;
    } finally {
      this.#set({ progress: undefined });
      patchPanel(this.id, { busy: false });
    }
  }

  /** Stops generating after the batch in flight. */
  cancel(): void {
    this.#cancelled = true;
  }

  dismissNotice(): void {
    this.#set({ notice: undefined });
  }

  async dispose(): Promise<void> {
    this.#cancelled = true;
    await this.#lane.close();
  }
}

export function useDataGenerator<T>(
  panel: DataGenerator,
  select: (state: DataGeneratorState) => T,
): T {
  return useStore(panel.store, select);
}
