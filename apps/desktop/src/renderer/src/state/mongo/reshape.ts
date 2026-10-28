import {
  formatShell,
  outputStage,
  reshapeStages,
  toEjson,
  type BsonDocument,
  type Namespace,
  type ReshapeAction,
  type ReshapeOutputMode,
  type ReshapeRule,
} from '@querybara/mongo-tools';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

import { errorMessage } from '../../lib/errors';
import { confirm } from '../dialogs';
import { loadChildren } from '../explorer';
import { patchPanel } from '../panels';
import { SessionLane } from '../session-lane';
import { namespaceReference } from './explorer';
import { csvFields } from './file-transfer';
import { DocumentResults } from './results';
import { DEFAULT_WRITE_RULES, loadWriteRules, type WriteRules } from './write-rules';

/**
 * Studio 3T's Reschema and Data Masking (ADR 0038), one panel with two faces: the collection's
 * fields as rules (keep under a new path, convert, leave out; or mask, fix, null, randomise),
 * compiled into a pipeline that the server runs into another collection with `$out` (replacing
 * it) or `$merge` (by `_id`). A preview shows the first documents before and after; the
 * pipeline opens in the aggregation editor too.
 */

export type ReshapeKind = 'reschema' | 'mask';

export interface ReshapeTarget {
  readonly profileId: string;
  readonly db: string;
  readonly collection: string;
  readonly kind: ReshapeKind;
}

/** A rule as the panel edits it: the compiler's rule plus a row id. */
export interface RuleRow extends ReshapeRule {
  readonly id: number;
}

export interface ReshapeState {
  readonly rules: readonly RuleRow[];
  readonly onlyListed: boolean;
  readonly output: string;
  readonly outputMode: ReshapeOutputMode;
  readonly scanning: boolean;
  readonly running: boolean;
  readonly previewing: boolean;
  readonly writeRules: WriteRules;
  readonly notice: { readonly kind: 'success' | 'error'; readonly text: string } | undefined;
}

/** The actions each face offers. */
export const RESHAPE_KIND_ACTIONS: Readonly<Record<ReshapeKind, readonly ReshapeAction[]>> = {
  reschema: ['keep', 'convert', 'exclude', 'computed'],
  mask: ['keep', 'mask', 'fixed', 'null', 'random-number', 'random-date', 'exclude'],
};

export const RESHAPE_ACTION_LABELS: Readonly<Record<ReshapeAction, string>> = {
  keep: 'Keep',
  convert: 'Convert to',
  exclude: 'Leave out',
  mask: 'Mask characters',
  fixed: 'Replace with',
  null: 'Set to null',
  'random-number': 'Randomise number',
  'random-date': 'Randomise date',
  computed: 'Computed',
};

const SAMPLE = 10;

export class Reshape {
  readonly id: string;
  readonly target: ReshapeTarget;
  readonly store: StoreApi<ReshapeState>;
  /** The first documents as they are, and as the rules make them. */
  readonly before = new DocumentResults({ mode: 'json' });
  readonly after = new DocumentResults({ mode: 'json' });
  readonly #lane: SessionLane;
  #nextId = 1;

  constructor(id: string, target: ReshapeTarget) {
    this.id = id;
    this.target = target;
    this.store = createStore<ReshapeState>()(() => ({
      rules: [],
      onlyListed: false,
      output: `${target.collection}_${target.kind === 'mask' ? 'masked' : 'reschema'}`,
      outputMode: 'replace',
      scanning: false,
      running: false,
      previewing: false,
      writeRules: DEFAULT_WRITE_RULES,
      notice: undefined,
    }));
    this.#lane = new SessionLane(target.profileId, target.db);
  }

  get state(): ReshapeState {
    return this.store.getState();
  }

  get ns(): Namespace {
    return { db: this.target.db, collection: this.target.collection };
  }

  #set(patch: Partial<ReshapeState>): void {
    this.store.setState(patch);
  }

  async init(): Promise<void> {
    this.#set({ writeRules: await loadWriteRules(this.target.profileId) });
    await this.scan();
  }

  /** Reads the collection's fields from a sample, a rule each (kept as it is). */
  async scan(): Promise<void> {
    this.#set({ scanning: true, notice: undefined });
    try {
      const analysis = await this.#lane.run((host, sessionId) =>
        host.mongo.analyzeSchema({ sessionId, ns: this.ns, options: { sampleSize: 1000 } }),
      );
      const known = new Map(this.state.rules.map((rule) => [rule.field, rule]));
      const computed = this.state.rules.filter((rule) => rule.action === 'computed');
      this.#set({
        rules: [
          ...csvFields(analysis).map(
            (field) => known.get(field) ?? { id: this.#nextId++, field, action: 'keep' as const },
          ),
          ...computed,
        ],
      });
    } catch (error) {
      this.#set({ notice: { kind: 'error', text: `Fields: ${errorMessage(error)}` } });
    } finally {
      this.#set({ scanning: false });
    }
  }

  setRule(id: number, patch: Partial<ReshapeRule>): void {
    this.#set({
      rules: this.state.rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)),
    });
  }

  addComputed(): void {
    this.#set({
      rules: [
        ...this.state.rules,
        { id: this.#nextId++, field: '', action: 'computed', target: '', value: '' },
      ],
    });
  }

  removeRule(id: number): void {
    this.#set({ rules: this.state.rules.filter((rule) => rule.id !== id) });
  }

  setOnlyListed(onlyListed: boolean): void {
    this.#set({ onlyListed });
  }

  setOutput(output: string, mode?: ReshapeOutputMode): void {
    this.#set({ output, ...(mode ? { outputMode: mode } : {}) });
  }

  /** The stages the rules make; throws VALIDATION_FAILED naming the rule that cannot work. */
  stages(): BsonDocument[] {
    return reshapeStages(
      this.state.rules.map(({ id: _id, ...rule }) => rule),
      { onlyListed: this.state.onlyListed },
    );
  }

  /** The whole pipeline, with the stage that writes, as mongosh text; or why there is none. */
  pipelineText(): { readonly text: string } | { readonly error: string } {
    try {
      const stages = [...this.stages(), outputStage(this.#output(), this.state.outputMode)];
      return { text: formatShell(stages) };
    } catch (error) {
      return { error: errorMessage(error) };
    }
  }

  #output(): string {
    return this.state.output.trim();
  }

  #outputIssue(): string | undefined {
    const name = this.#output();
    if (name === '') return 'Name the collection to write to';
    if (name.includes('$') || name.startsWith('system.')) return `${name} is not a collection name`;
    if (name === this.target.collection) return 'Write to another collection than the source';
    return undefined;
  }

  /** Runs the rules on the first documents, without writing, for the before/after preview. */
  async preview(): Promise<void> {
    let stages: BsonDocument[];
    try {
      stages = this.stages();
    } catch (error) {
      this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
      return;
    }
    this.#set({ previewing: true, notice: undefined });
    this.before.begin(undefined, [], 0);
    this.after.begin(undefined, [], 0);
    const read = (pipeline: BsonDocument[]) =>
      this.#lane.run(async (host, sessionId) => {
        const stream = host.mongo.aggregate({
          sessionId,
          ns: this.ns,
          pipeline: toEjson(pipeline),
          pageSize: SAMPLE,
        });
        const out: string[] = [];
        for await (const page of stream) out.push(...page.documents);
        return out;
      });
    const head: BsonDocument[] = [{ $sort: { _id: 1 } }, { $limit: SAMPLE }];
    try {
      const [before, after] = await Promise.all([read(head), read([...head, ...stages])]);
      this.before.append(before, false);
      this.after.append(after, false);
    } catch (error) {
      this.after.fail(errorMessage(error));
    } finally {
      this.#set({ previewing: false });
    }
  }

  /** Writes the reshaped documents into the output collection, after the confirmation. */
  async run(): Promise<boolean> {
    if (this.state.writeRules.readOnlyProfile) {
      this.#set({ notice: { kind: 'error', text: 'This connection is read-only.' } });
      return false;
    }
    const issue = this.#outputIssue();
    if (issue !== undefined) {
      this.#set({ notice: { kind: 'error', text: issue } });
      return false;
    }
    let stages: BsonDocument[];
    try {
      stages = [...this.stages(), outputStage(this.#output(), this.state.outputMode)];
    } catch (error) {
      this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
      return false;
    }
    const replace = this.state.outputMode === 'replace';
    const ok = await confirm({
      title: `Write ${this.target.collection} ${this.target.kind === 'mask' ? 'masked' : 'reshaped'} into ${this.#output()}?`,
      message: `${replace ? `$out replaces what ${this.#output()} holds (it is made when missing)` : `$merge replaces the documents of ${this.#output()} with the same _id and adds the rest`}${this.state.writeRules.production ? ', on this production connection' : ''}. ${this.target.collection} itself stays as it is. This runs:`,
      detail: `${namespaceReference(this.target.db, this.target.collection)}.aggregate(${formatShell(stages)})`,
      confirmLabel: 'Run and write',
      danger: true,
    });
    if (!ok) return false;
    this.#set({ running: true, notice: undefined });
    patchPanel(this.id, { busy: true });
    try {
      await this.#lane.run(async (host, sessionId) => {
        const stream = host.mongo.aggregate({
          sessionId,
          ns: this.ns,
          pipeline: toEjson(stages),
          confirmed: true,
        });
        for await (const _page of stream) {
          // $out and $merge return no documents; reading runs the pipeline to its end.
        }
      });
      const count = await this.#lane.run((host, sessionId) =>
        host.mongo.estimatedCount({
          sessionId,
          ns: { db: this.target.db, collection: this.#output() },
        }),
      );
      this.#set({
        notice: {
          kind: 'success',
          text: `${this.#output()} now holds ${count.count} ${count.count === 1 ? 'document' : 'documents'}.`,
        },
      });
      void loadChildren(this.target.profileId, [this.target.db, 'collections']).catch(
        () => undefined,
      );
      return true;
    } catch (error) {
      this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
      return false;
    } finally {
      this.#set({ running: false });
      patchPanel(this.id, { busy: false });
    }
  }

  /** The pipeline without the stage that writes, as aggregation editor text; or undefined. */
  aggregationText(): string | undefined {
    try {
      return formatShell(this.stages());
    } catch (error) {
      this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
      return undefined;
    }
  }

  dismissNotice(): void {
    this.#set({ notice: undefined });
  }

  async dispose(): Promise<void> {
    await this.#lane.close();
  }
}

export function useReshape<T>(panel: Reshape, select: (state: ReshapeState) => T): T {
  return useStore(panel.store, select);
}
