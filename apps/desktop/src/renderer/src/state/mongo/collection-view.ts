import { QuerybaraError, requiresWriteConfirmation } from '@querybara/core';
import type { MongoExplainResult, MongoSavedPipeline } from '@querybara/ipc';
import {
  collectionReference,
  formatShellInline,
  fromEjson,
  isBsonDocument,
  toEjson,
  toFindQuery,
  withValueAt,
  type BsonDocument,
  type BsonValue,
  type DocumentPath,
  type ExplainVerbosity,
  type FindQuery,
  type Namespace,
  type QueryModel,
} from '@querybara/mongo-tools';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

import { errorInfo, errorMessage } from '../../lib/errors';
import { formatCount } from '../../lib/format';
import { mainApi } from '../../lib/main-client';
import { profileById, queryClient } from '../data';
import { confirm } from '../dialogs';
import { patchPanel } from '../panels';
import { SessionLane } from '../session-lane';
import { BulkFlow, bulkState, type BulkKind, type BulkState } from './bulk-flow';
import type { CodeExportRequest } from './code-export';
import { insertedDocument, recordChange } from './collection-history';
import { EditorFlow, cloneState, editState, insertState, type EditorState } from './editor-flow';
import { namespaceReference } from './explorer';
import {
  EMPTY_FIELDS,
  checkFields,
  findTextOf,
  modelOf,
  parseFindInput,
  type QueryExtras,
  type QueryField,
  type QueryFields,
  type TextIssue,
} from './query-bar';
import { QueryBuilder } from './query-builder';
import { DEFAULT_DOCUMENT_PAGE, lastPage, pageWindow, queryTotal } from './pages';
import { DocumentResults, type ResultMode } from './results';

/**
 * One collection view (spec §9, "Browsing and editing"): the query bar, the documents one page
 * at a time as Navicat pages them (state/mongo/pages.ts), counts (the collection's estimate, the exact number
 * of matches on demand), the table, tree and JSON views, the query as code, the document editor,
 * bulk update and delete by the current filter, and explain: Studio 3T's collection tab (ADR 0036). Everything runs on the view's own session. The
 * write rules follow the profile as the SQL table view's do: a read-only profile edits nothing,
 * a production one confirms every write, and bulk writes always confirm their matched count.
 */

export interface CollectionTarget {
  readonly profileId: string;
  readonly db: string;
  readonly collection: string;
  /** What the explorer showed; views are read-only. */
  readonly kind: 'collection' | 'view' | 'time-series';
}

const PAGE_SIZE_KEY = 'querybara.mongo.pageSize';
const VIEW_KEY = 'querybara.mongo.view';

/** The page size last chosen, kept in this browser profile (a convenience, not a setting). */
function readPageSize(): number {
  try {
    const stored = Number(localStorage.getItem(PAGE_SIZE_KEY));
    return Number.isInteger(stored) && stored >= 1 && stored <= 100_000
      ? stored
      : DEFAULT_DOCUMENT_PAGE;
  } catch {
    return DEFAULT_DOCUMENT_PAGE;
  }
}

function savePageSize(size: number): void {
  try {
    localStorage.setItem(PAGE_SIZE_KEY, String(size));
  } catch {
    // Not kept: the next view starts with the default.
  }
}

/** The result view last chosen (Table View, as Studio 3T opens, until another is picked). */
function readView(): ResultMode {
  try {
    const stored = localStorage.getItem(VIEW_KEY);
    return stored === 'tree' || stored === 'json' ? stored : 'table';
  } catch {
    return 'table';
  }
}

function saveView(mode: ResultMode): void {
  try {
    localStorage.setItem(VIEW_KEY, mode);
  } catch {
    // Not kept: the next view starts with Table View.
  }
}

/** The collection tab's sections, as Studio 3T's: Result, Query Code and Explain. */
export type ViewSection = 'result' | 'code' | 'explain';

export interface ExplainState {
  readonly verbosity: ExplainVerbosity;
  readonly loading: boolean;
  readonly result: MongoExplainResult | undefined;
  readonly error: string | undefined;
}

export interface Notice {
  readonly kind: 'info' | 'success' | 'error';
  readonly text: string;
}

/** The editor, and which loaded document it edits (none for an insert or a clone). */
export type OpenEditor = EditorState & { readonly index: number | undefined };

export interface CollectionViewState {
  readonly fields: QueryFields;
  readonly extras: QueryExtras;
  readonly issues: Partial<Record<QueryField, TextIssue>>;
  /** The find() text as shown (and edited) beside the fields. */
  readonly findText: string;
  readonly findIssue: TextIssue | undefined;
  /** The query the loaded documents came from; undefined before the first run. */
  readonly active: QueryModel | undefined;
  readonly running: boolean;
  /** The page shown, from 1, and its size. */
  readonly page: number;
  readonly pageSize: number;
  /** The page shown is full: another may follow. */
  readonly hasNext: boolean;
  readonly durationMs: number | undefined;
  /** The collection's size from its metadata: undefined while reading, null when unknown. */
  readonly estimate: number | null | undefined;
  /** Documents matching the active filter, counted on demand. */
  readonly exactCount: number | undefined;
  readonly counting: boolean;
  readonly section: ViewSection;
  readonly explain: ExplainState | undefined;
  readonly notice: Notice | undefined;
  readonly readOnlyProfile: boolean;
  readonly production: boolean;
  /** Every write asks first (production, or the profile says so). */
  readonly confirmWrites: boolean;
  readonly editor: OpenEditor | undefined;
  readonly bulk: BulkState | undefined;
  /** The collection's saved queries (Studio 3T's, ADR 0036), ordered by name. */
  readonly saved: readonly MongoSavedPipeline[];
}

/** A query run before on the collection, from the query history. */
export interface PastQuery {
  readonly id: string;
  readonly text: string;
  readonly at: string;
  readonly failed: boolean;
}

export class CollectionView {
  readonly id: string;
  readonly target: CollectionTarget;
  readonly store: StoreApi<CollectionViewState>;
  readonly results = new DocumentResults({ mode: readView() });
  /** The visual query builder, the query bar's second editor. */
  readonly builder: QueryBuilder;
  readonly #lane: SessionLane;
  #runId = 0;
  #count: AbortController | undefined;
  #editor: EditorFlow | undefined;
  #bulk: BulkFlow | undefined;

  constructor(id: string, target: CollectionTarget, fields: Partial<QueryFields> = {}) {
    this.id = id;
    this.target = target;
    const initial = { ...EMPTY_FIELDS, ...fields };
    this.store = createStore<CollectionViewState>()(() => ({
      fields: initial,
      extras: {},
      issues: checkFields(initial),
      findText: findTextOf(target.collection, initial) ?? '',
      findIssue: undefined,
      active: undefined,
      running: false,
      page: 1,
      pageSize: readPageSize(),
      hasNext: false,
      durationMs: undefined,
      estimate: undefined,
      exactCount: undefined,
      counting: false,
      section: 'result',
      explain: undefined,
      notice: undefined,
      readOnlyProfile: false,
      production: false,
      confirmWrites: false,
      editor: undefined,
      bulk: undefined,
      saved: [],
    }));
    this.#lane = new SessionLane(target.profileId, target.db);
    this.builder = new QueryBuilder({
      collection: target.collection,
      query: () => this.state,
      subscribe: (listener) => this.store.subscribe(listener),
      setFindText: (text) => this.setFindText(text),
      sample: (sampleSize, signal) =>
        this.#lane.run((host, sessionId) =>
          host.mongo.analyzeSchema({ sessionId, ns: this.ns, options: { sampleSize } }, { signal }),
        ),
    });
  }

  get state(): CollectionViewState {
    return this.store.getState();
  }

  get ns(): Namespace {
    return { db: this.target.db, collection: this.target.collection };
  }

  /** Views are read-only, and so is everything on a read-only profile. */
  get writable(): boolean {
    return this.target.kind !== 'view' && !this.state.readOnlyProfile;
  }

  /** Documents read with a projection are partial, so they cannot be edited or cloned. */
  get editable(): boolean {
    return this.writable && this.state.active?.projection === undefined;
  }

  #set(patch: Partial<CollectionViewState>): void {
    this.store.setState(patch);
  }

  /** Reads the profile's write rules and runs the query. */
  async init(): Promise<void> {
    const profile = await profileById(this.target.profileId);
    if (profile) {
      this.#set({
        readOnlyProfile: profile.presentation.readOnly,
        production: profile.presentation.environment === 'production',
        confirmWrites: requiresWriteConfirmation(profile),
      });
    }
    await this.run();
  }

  // -------------------------------------------------------------------------------------------
  // Query bar

  /** A field typed by the user: checked, and the find() text follows when every field is valid. */
  setField(field: QueryField, text: string): void {
    const fields = { ...this.state.fields, [field]: text };
    const findText = findTextOf(this.target.collection, fields, this.state.extras);
    this.#set({
      fields,
      issues: checkFields(fields),
      ...(findText !== undefined ? { findText, findIssue: undefined } : {}),
    });
  }

  /** The find() text edited by hand: when it parses the fields follow it. */
  setFindText(text: string): void {
    const parsed = parseFindInput(text, this.target.collection);
    if (!parsed.ok) {
      this.#set({ findText: text, findIssue: parsed.issue });
      return;
    }
    this.#set({
      findText: text,
      findIssue: undefined,
      fields: parsed.fields,
      extras: parsed.extras,
      issues: {},
    });
  }

  /** The query in the bar as code export takes it; undefined while a field does not parse. */
  codeRequest(): CodeExportRequest | undefined {
    const s = this.state;
    if (s.findIssue || Object.keys(s.issues).length > 0) return undefined;
    try {
      return {
        target: {
          kind: 'find',
          collection: this.target.collection,
          query: modelOf(s.fields, s.extras),
        },
        database: this.target.db,
      };
    } catch {
      return undefined;
    }
  }

  /** `codeRequest`, saying what to fix in a notice when there is none. */
  exportRequest(): CodeExportRequest | undefined {
    const request = this.codeRequest();
    if (!request) this.#set({ notice: { kind: 'error', text: 'Fix the query first.' } });
    return request;
  }

  /**
   * What Export… takes from the tab (ADR 0037): the collection, and the query in the bar to
   * export just what it finds. Without a valid query, the whole collection.
   */
  fileExport(): {
    readonly profileId: string;
    readonly db: string;
    readonly collections: readonly string[];
    readonly query?: { collection: string; query: FindQuery; text: string };
  } {
    const s = this.state;
    const base = {
      profileId: this.target.profileId,
      db: this.target.db,
      collections: [this.target.collection],
    };
    if (s.findIssue || Object.keys(s.issues).length > 0) return base;
    try {
      const query = toFindQuery(modelOf(s.fields, s.extras));
      return { ...base, query: { collection: this.target.collection, query, text: s.findText } };
    } catch {
      return base;
    }
  }

  /** Replaces the query with `fields` (a query opened from elsewhere) and runs it. */
  async applyFields(fields: QueryFields): Promise<void> {
    this.#set({
      fields,
      extras: {},
      issues: checkFields(fields),
      findText: findTextOf(this.target.collection, fields) ?? this.state.findText,
      findIssue: undefined,
    });
    await this.run();
  }

  /** Clears the query and runs it again. */
  async reset(): Promise<void> {
    this.#set({
      fields: EMPTY_FIELDS,
      extras: {},
      issues: {},
      findText: findTextOf(this.target.collection, EMPTY_FIELDS) ?? '',
      findIssue: undefined,
    });
    await this.run();
  }

  // -------------------------------------------------------------------------------------------
  // Running and paging

  /**
   * Runs the query in the bar from the first page; problems are shown instead of running. With
   * `one`, only its first document (Studio 3T's findOne(…)).
   */
  async run(options: { readonly one?: boolean } = {}): Promise<void> {
    const s = this.state;
    const pending = this.builder.pendingIssue();
    if (s.findIssue || Object.keys(s.issues).length > 0 || pending !== undefined) {
      this.#set({
        notice: {
          kind: 'error',
          text: pending === undefined ? 'Fix the query first.' : `Fix the query first. ${pending}`,
        },
      });
      return;
    }
    let model: QueryModel;
    try {
      model = modelOf(s.fields, s.extras);
    } catch (error) {
      this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
      return;
    }
    if (options.one) model = { ...model, limit: 1 };
    this.#count?.abort();
    this.#set({
      active: model,
      exactCount: undefined,
      notice: undefined,
      explain: undefined,
      section: 'result',
    });
    const started = performance.now();
    const text = s.findText;
    const shown = await this.#loadPage(1);
    const durationMs = Math.round(performance.now() - started);
    if (shown) this.#set({ durationMs });
    // A run a later one replaced is not recorded; a failed one is.
    const failed = this.results.state.error;
    if (shown || failed !== undefined) {
      void this.#record(text, failed, durationMs, this.results.state.documents.length);
    }
    void this.#refreshEstimate();
  }

  // -------------------------------------------------------------------------------------------
  // Query history and saved queries (Studio 3T's, ADR 0036)

  /** The prefix of this collection's find() text, which its history entries start with. */
  #findPrefix(): string {
    return `${collectionReference(this.target.collection)}.find(`;
  }

  /** Records a run in the app's query history; a run never fails because it could not. */
  async #record(
    text: string,
    error: string | undefined,
    durationMs: number,
    rowCount: number,
  ): Promise<void> {
    if (text.trim() === '') return;
    try {
      await mainApi().history.add({
        profileId: this.target.profileId,
        database: this.target.db,
        text,
        status: error === undefined ? 'success' : 'error',
        error: error ?? null,
        durationMs,
        rowCount,
      });
      await queryClient.invalidateQueries({ queryKey: ['history'] });
    } catch {
      // Best effort, as IntelliShell's.
    }
  }

  /** The collection's recent queries, newest first, without repeats. */
  async queryHistory(limit = 30): Promise<PastQuery[]> {
    const prefix = this.#findPrefix();
    const page = await mainApi().history.search({
      query: prefix.slice(0, -1),
      profileId: this.target.profileId,
      limit: 200,
    });
    const seen = new Set<string>();
    const out: PastQuery[] = [];
    for (const entry of page.entries) {
      if (entry.database !== this.target.db || !entry.text.startsWith(prefix)) continue;
      if (seen.has(entry.text)) continue;
      seen.add(entry.text);
      out.push({
        id: entry.id,
        text: entry.text,
        at: entry.executedAt,
        failed: entry.status === 'error',
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Puts a past or saved find() back in the query bar and runs it. */
  async reuse(text: string): Promise<void> {
    this.setFindText(text);
    if (this.state.findIssue) {
      this.#set({ notice: { kind: 'error', text: 'That query no longer parses here.' } });
      return;
    }
    await this.run();
  }

  #scope() {
    return {
      profileId: this.target.profileId,
      db: this.target.db,
      collection: this.target.collection,
    };
  }

  async refreshSaved(): Promise<void> {
    try {
      this.#set({ saved: await mainApi().mongo.queries.list(this.#scope()) });
    } catch (error) {
      this.#set({ notice: { kind: 'error', text: `Saved queries: ${errorMessage(error)}` } });
    }
  }

  /** Saves the query in the bar under `name`, over a saved query of that name if there is one. */
  async saveQuery(name: string): Promise<boolean> {
    const trimmed = name.trim();
    if (trimmed === '') return false;
    if (this.state.findIssue || Object.keys(this.state.issues).length > 0) {
      this.#set({ notice: { kind: 'error', text: 'Fix the query first.' } });
      return false;
    }
    const existing = this.state.saved.find((query) => query.name === trimmed);
    try {
      const saved = await mainApi().mongo.queries.save({
        ...this.#scope(),
        ...(existing ? { id: existing.id } : {}),
        name: trimmed,
        text: this.state.findText,
      });
      this.#set({ notice: { kind: 'success', text: `Saved as "${saved.name}"` } });
      await this.refreshSaved();
      return true;
    } catch (error) {
      this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
      return false;
    }
  }

  async deleteSaved(id: string): Promise<void> {
    const entry = this.state.saved.find((query) => query.id === id);
    if (!entry) return;
    const ok = await confirm({
      title: `Delete the saved query "${entry.name}"?`,
      message: 'The query in the bar stays; only the saved copy goes.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await mainApi().mongo.queries.delete({ id });
      await this.refreshSaved();
    } catch (error) {
      this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
    }
  }

  /**
   * Shows another page of the query run last. The last page takes the exact count, counted
   * first when it is not known yet.
   */
  async goToPage(move: 'first' | 'previous' | 'next' | 'last' | number): Promise<void> {
    const s = this.state;
    const active = s.active;
    if (!active || s.running) return;
    let target: number;
    if (move === 'last') {
      if (s.exactCount === undefined) await this.countExactly();
      const count = this.state.exactCount;
      if (count === undefined) return;
      target = lastPage(queryTotal(count, active), s.pageSize);
    } else if (move === 'first') target = 1;
    else if (move === 'previous') target = s.page - 1;
    else if (move === 'next') target = s.hasNext ? s.page + 1 : s.page;
    else target = Math.floor(move);
    if (target < 1 || target === s.page) return;
    await this.#loadPage(target);
  }

  /** Documents per page, kept for every collection; the view starts over on the first page. */
  async setPageSize(size: number): Promise<void> {
    if (size === this.state.pageSize) return;
    savePageSize(size);
    this.#set({ pageSize: size });
    if (this.state.active) await this.#loadPage(1);
  }

  /**
   * Reads one page: a find with the page's skip and limit inside the query's own. True when it
   * was shown (a later run did not replace it).
   */
  async #loadPage(page: number): Promise<boolean> {
    const active = this.state.active;
    if (!active) return false;
    const runId = ++this.#runId;
    const size = this.state.pageSize;
    const window = pageWindow(page, size, active);
    this.results.begin(undefined, [], (page - 1) * size);
    this.#set({ running: true, page });
    patchPanel(this.id, { busy: true });
    try {
      let documents: readonly string[] = [];
      if (window) {
        documents = await this.#lane.run(async (host, sessionId) => {
          const stream = host.mongo.find({
            sessionId,
            ns: this.ns,
            query: { ...toFindQuery(active), skip: window.skip, limit: window.limit },
            pageSize: window.limit,
          });
          try {
            const first = await stream.next();
            return first.done ? [] : first.value.documents;
          } finally {
            await stream.return().catch(() => undefined);
          }
        });
      }
      if (runId !== this.#runId) return false;
      this.results.append(documents, false);
      this.#set({
        hasNext:
          window !== undefined &&
          documents.length >= window.limit &&
          pageWindow(page + 1, size, active) !== undefined,
      });
      return true;
    } catch (error) {
      if (runId !== this.#runId) return false;
      this.results.fail(errorMessage(error));
      this.#set({ hasNext: false });
      return false;
    } finally {
      if (runId === this.#runId) {
        this.#set({ running: false });
        patchPanel(this.id, { busy: false });
      }
    }
  }

  async #refreshEstimate(): Promise<void> {
    this.#set({ estimate: undefined });
    try {
      const { count } = await this.#lane.run((host, sessionId) =>
        host.mongo.estimatedCount({ sessionId, ns: this.ns }),
      );
      this.#set({ estimate: count });
    } catch {
      this.#set({ estimate: null });
    }
  }

  /** Counts the documents matching the active filter exactly (spec §9: exact on demand). */
  async countExactly(): Promise<void> {
    const active = this.state.active;
    if (this.state.counting || !active) return;
    const controller = new AbortController();
    this.#count = controller;
    this.#set({ counting: true });
    try {
      const { count } = await this.#lane.run((host, sessionId) =>
        host.mongo.count(
          { sessionId, ns: this.ns, filter: toEjson(active.filter) },
          { signal: controller.signal },
        ),
      );
      if (this.#count === controller) this.#set({ exactCount: count });
    } catch (error) {
      if (errorInfo(error).code !== 'CANCELLED' && !controller.signal.aborted) {
        this.#set({ notice: { kind: 'error', text: `Count failed: ${errorMessage(error)}` } });
      }
    } finally {
      if (this.#count === controller) {
        this.#count = undefined;
        this.#set({ counting: false });
      }
    }
  }

  cancelCount(): void {
    this.#count?.abort();
    this.#count = undefined;
    this.#set({ counting: false });
  }

  setSection(section: ViewSection): void {
    this.#set({ section });
  }

  /** Table, Tree or JSON View (kept for the next collection tab); shows the result. */
  setView(mode: ResultMode): void {
    this.results.setMode(mode);
    saveView(mode);
    this.#set({ section: 'result' });
  }

  dismissNotice(): void {
    this.#set({ notice: undefined });
  }

  // -------------------------------------------------------------------------------------------
  // Explain

  /** Explains the query in the bar (queryPlanner, or executionStats which runs it). */
  async explain(verbosity: ExplainVerbosity = 'executionStats'): Promise<void> {
    const pending = this.builder.pendingIssue();
    if (pending !== undefined) {
      this.#set({ notice: { kind: 'error', text: `Fix the query first. ${pending}` } });
      return;
    }
    let model: QueryModel;
    try {
      model = modelOf(this.state.fields, this.state.extras);
    } catch (error) {
      this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
      return;
    }
    this.#set({
      section: 'explain',
      explain: { verbosity, loading: true, result: undefined, error: undefined },
    });
    try {
      const result = await this.#lane.run((host, sessionId) =>
        host.mongo.explain({
          sessionId,
          ns: this.ns,
          target: { kind: 'find', query: toFindQuery(model) },
          verbosity,
        }),
      );
      this.#set({ explain: { verbosity, loading: false, result, error: undefined } });
    } catch (error) {
      this.#set({
        explain: { verbosity, loading: false, result: undefined, error: errorMessage(error) },
      });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Writes

  #nsRef(): string {
    return namespaceReference(this.target.db, this.target.collection);
  }

  /** Asks before a write on a production (or confirm-writes) profile; true when it may run. */
  async #confirmWrite(title: string, command: string): Promise<boolean> {
    if (!this.state.confirmWrites) return true;
    return confirm({
      title,
      message: this.state.production
        ? 'This connection is marked production, so every write asks first.'
        : 'This connection asks before every write.',
      detail: command,
      confirmLabel: 'Run it',
      danger: true,
    });
  }

  #refuse(): boolean {
    if (this.writable) return false;
    this.#set({
      notice: {
        kind: 'error',
        text:
          this.target.kind === 'view' ? 'A view is read-only.' : 'This connection is read-only.',
      },
    });
    return true;
  }

  /** The `_id` of a loaded document, as Extended JSON. */
  #idOf(index: number): string | undefined {
    const value = this.results.values()[index];
    if (!isBsonDocument(value) || value['_id'] === undefined) return undefined;
    return toEjson(value['_id']);
  }

  #idText(id: string): string {
    return formatShellInline(fromEjson(id, '_id'));
  }

  /** Opens the document editor: edit or clone a loaded document, or insert a new one. */
  openEditor(mode: 'edit' | 'clone' | 'insert', index?: number): void {
    if (this.#refuse()) return;
    const document = index === undefined ? undefined : this.results.state.documents[index];
    if (mode !== 'insert' && document === undefined) return;
    if (mode !== 'insert' && !this.editable) {
      this.#set({
        notice: {
          kind: 'error',
          text: 'These documents were read with a projection; clear it to edit whole documents.',
        },
      });
      return;
    }
    const state =
      mode === 'edit'
        ? editState(document!)
        : mode === 'clone'
          ? cloneState(document!)
          : insertState();
    const editIndex = mode === 'edit' ? index : undefined;
    this.#editor = new EditorFlow(
      state,
      {
        replace: async (original, replacement) => {
          const id = toEjson((fromEjson(original) as BsonDocument)['_id']!);
          const confirmed = await this.#confirmWrite(
            'Replace the document?',
            `${this.#nsRef()}.replaceOne({ _id: ${this.#idText(id)} }, ${formatShellInline(fromEjson(replacement))})`,
          );
          if (!confirmed) throw new QuerybaraError({ code: 'CANCELLED', message: 'Not saved' });
          const summary = await this.#lane.run((host, sessionId) =>
            host.mongo.replaceOne({
              sessionId,
              ns: this.ns,
              original,
              replacement,
              confirmed: this.state.confirmWrites,
            }),
          );
          recordChange(this.target, { operation: 'update', before: original, after: replacement });
          return summary;
        },
        insert: async (document) => {
          const confirmed = await this.#confirmWrite(
            'Insert the document?',
            `${this.#nsRef()}.insertOne(${formatShellInline(fromEjson(document))})`,
          );
          if (!confirmed) throw new QuerybaraError({ code: 'CANCELLED', message: 'Not saved' });
          const result = await this.#lane.run((host, sessionId) =>
            host.mongo.insertOne({
              sessionId,
              ns: this.ns,
              document,
              confirmed: this.state.confirmWrites,
            }),
          );
          recordChange(this.target, {
            operation: 'insert',
            after: insertedDocument(document, result.insertedId),
          });
          return result;
        },
      },
      (next) => this.#set({ editor: { ...next, index: editIndex } }),
    );
    this.#set({ editor: { ...state, index: editIndex } });
  }

  setEditorText(text: string): void {
    this.#editor?.setText(text);
  }

  /** Saves the editor; on success the view shows the document as stored. */
  async saveEditor(): Promise<boolean> {
    const flow = this.#editor;
    const index = this.state.editor?.index;
    if (!flow) return false;
    const outcome = await flow.save();
    if (!outcome.ok) return false;
    this.closeEditor();
    if (flow.state.mode === 'edit' && index !== undefined) {
      await this.#reread(index);
      this.#set({ notice: { kind: 'success', text: 'Document saved' } });
    } else {
      // Read again first: a run clears the notice.
      await this.run();
      this.#set({ notice: { kind: 'success', text: 'Document inserted' } });
    }
    return true;
  }

  /** After a conflict: edit the current version instead. */
  reloadEditor(): void {
    this.#editor?.reload();
  }

  /** After a conflict: overwrite the current version with the edit, once the user agrees. */
  async overwriteEditor(): Promise<boolean> {
    const flow = this.#editor;
    const current = flow?.state.current;
    if (!flow || !current) return false;
    const ok = await confirm({
      title: 'Overwrite the newer version?',
      message:
        'Someone changed this document after you opened it. Overwriting replaces their version with yours.',
      detail: current.text,
      confirmLabel: 'Overwrite',
      danger: true,
    });
    if (!ok) return false;
    const index = this.state.editor?.index;
    const outcome = await flow.overwrite();
    if (!outcome.ok) return false;
    this.closeEditor();
    if (index !== undefined) await this.#reread(index);
    this.#set({ notice: { kind: 'success', text: 'Document saved' } });
    return true;
  }

  closeEditor(): void {
    this.#editor = undefined;
    this.#set({ editor: undefined });
  }

  /** Reads one loaded document again by its `_id` (after an edit). */
  async #reread(index: number): Promise<void> {
    const id = this.#idOf(index);
    if (id === undefined) return;
    try {
      const stream = await this.#lane.run(async (host, sessionId) =>
        host.mongo.find({ sessionId, ns: this.ns, query: { filter: `{"_id":${id}}`, limit: 1 } }),
      );
      let fresh: string | undefined;
      for await (const page of stream) fresh ??= page.documents[0];
      if (fresh !== undefined) this.results.replaceAt(index, fresh);
    } catch (error) {
      this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
    }
  }

  /** Deletes one loaded document by its `_id`, after a confirmation that shows the command. */
  async deleteDocument(index: number): Promise<void> {
    if (this.#refuse()) return;
    const id = this.#idOf(index);
    if (id === undefined) {
      this.#set({ notice: { kind: 'error', text: 'This document has no _id to delete it by.' } });
      return;
    }
    const ok = await confirm({
      title: 'Delete this document?',
      message: this.state.production
        ? 'This connection is marked production. The document is deleted for good.'
        : 'The document is deleted for good.',
      detail: `${this.#nsRef()}.deleteOne({ _id: ${this.#idText(id)} })`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    // Recorded only as a whole document (not one read with a projection), so it can go back.
    const before = this.editable ? this.results.state.documents[index] : undefined;
    try {
      const summary = await this.#lane.run((host, sessionId) =>
        host.mongo.deleteOne({ sessionId, ns: this.ns, id, confirmed: true }),
      );
      if (summary.deletedCount > 0 && before !== undefined) {
        recordChange(this.target, { operation: 'delete', before });
      }
      if (summary.deletedCount > 0) this.results.removeAt(index);
      this.#set({
        notice: {
          kind: summary.deletedCount > 0 ? 'success' : 'info',
          text: summary.deletedCount > 0 ? 'Document deleted' : 'The document was already gone',
        },
        exactCount: undefined,
      });
    } catch (error) {
      this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
    }
  }

  /**
   * Edits one value in place (Studio 3T's Table and Tree views, ADR 0036): the loaded document
   * with `value` at `path` (undefined removes the field) replaces the stored one while that is
   * still unchanged. On a conflict the view shows the current version and nothing is written.
   * True when the value was saved.
   */
  async setValue(
    index: number,
    path: DocumentPath,
    value: BsonValue | undefined,
    what: 'edit' | 'remove' = 'edit',
  ): Promise<boolean> {
    if (this.#refuse()) return false;
    if (!this.editable) {
      this.#set({
        notice: {
          kind: 'error',
          text: 'These documents were read with a projection; clear it to edit whole documents.',
        },
      });
      return false;
    }
    const original = this.results.state.documents[index];
    if (original === undefined || path.length === 0 || path[0] === '_id') {
      this.#set({ notice: { kind: 'error', text: 'The _id of a document cannot change.' } });
      return false;
    }
    let replacement: string;
    try {
      replacement = toEjson(withValueAt(fromEjson(original, 'document'), path, value));
    } catch (error) {
      this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
      return false;
    }
    if (replacement === original) return true;
    const id = toEjson((fromEjson(original) as BsonDocument)['_id']!);
    const field = path.map(String).join('.');
    const command = `${this.#nsRef()}.replaceOne({ _id: ${this.#idText(id)} }, ${formatShellInline(fromEjson(replacement))})`;
    // Removing a field always asks; a value change asks where every write does.
    const confirmed =
      what === 'remove'
        ? await confirm({
            title: `Remove ${field}?`,
            message: this.state.production
              ? 'This connection is marked production. The field is removed from the stored document. This runs:'
              : 'The field is removed from the stored document. This runs:',
            detail: command,
            confirmLabel: 'Remove',
            danger: true,
          })
        : await this.#confirmWrite(`Save ${field}?`, command);
    if (!confirmed) return false;
    try {
      await this.#lane.run((host, sessionId) =>
        host.mongo.replaceOne({
          sessionId,
          ns: this.ns,
          original,
          replacement,
          confirmed: this.state.confirmWrites,
        }),
      );
      this.results.replaceAt(index, replacement);
      recordChange(this.target, { operation: 'update', before: original, after: replacement });
      this.#set({
        notice: {
          kind: 'success',
          text: what === 'remove' ? `Removed ${field}` : `Saved ${field}`,
        },
      });
      return true;
    } catch (error) {
      const info = errorInfo(error);
      if (info.code === 'CONFLICT' && info.detail !== undefined) {
        this.results.replaceAt(index, info.detail);
        this.#set({
          notice: {
            kind: 'error',
            text: 'The document changed since it was read, so it was not saved; it now shows the current version.',
          },
        });
      } else {
        this.#set({ notice: { kind: 'error', text: errorMessage(error) } });
      }
      return false;
    }
  }

  /** Removes a field (or an array element) of a loaded document, after a confirmation. */
  removeField(index: number, path: DocumentPath): Promise<boolean> {
    return this.setValue(index, path, undefined, 'remove');
  }

  // -------------------------------------------------------------------------------------------
  // Bulk update and delete

  /** The filter bulk writes use: the one the loaded documents were read with. */
  #bulkFilter(): string {
    const active = this.state.active ?? modelOf(this.state.fields, this.state.extras);
    return toEjson(active.filter);
  }

  /** Opens bulk update or delete by the current filter; a delete counts its matches at once. */
  openBulk(kind: BulkKind): void {
    if (this.#refuse()) return;
    const filter = this.#bulkFilter();
    const state = bulkState(kind, filter);
    const filterText = formatShellInline(fromEjson(filter));
    this.#bulk = new BulkFlow(
      state,
      {
        update: (f, update, dryRun) =>
          this.#lane.run((host, sessionId) =>
            host.mongo.updateMany({
              sessionId,
              ns: this.ns,
              filter: f,
              update,
              dryRun,
              ...(dryRun ? {} : { confirmed: true }),
            }),
          ),
        delete: (f, dryRun) =>
          this.#lane.run((host, sessionId) =>
            host.mongo.deleteMany({
              sessionId,
              ns: this.ns,
              filter: f,
              dryRun,
              ...(dryRun ? {} : { confirmed: true }),
            }),
          ),
        confirm: (matched) => {
          const update = this.#bulk?.state.updateText ?? '';
          return confirm({
            title:
              kind === 'update'
                ? `Update ${formatCount(matched)} ${matched === 1 ? 'document' : 'documents'}?`
                : `Delete ${formatCount(matched)} ${matched === 1 ? 'document' : 'documents'}?`,
            message: `${formatCount(matched)} ${matched === 1 ? 'document matches' : 'documents match'} the filter${this.state.production ? ' on this production connection' : ''}.`,
            detail:
              kind === 'update'
                ? `${this.#nsRef()}.updateMany(${filterText}, ${update.trim()})`
                : `${this.#nsRef()}.deleteMany(${filterText})`,
            confirmLabel: kind === 'update' ? 'Update' : 'Delete',
            danger: true,
          });
        },
      },
      (next) => this.#set({ bulk: next }),
    );
    this.#set({ bulk: state });
    if (kind === 'delete') void this.#bulk.count();
  }

  setBulkUpdateText(text: string): void {
    this.#bulk?.setUpdateText(text);
  }

  async countBulk(): Promise<void> {
    await this.#bulk?.count();
  }

  /** Runs the bulk write after the confirmation, then reads the documents again. */
  async runBulk(): Promise<boolean> {
    const flow = this.#bulk;
    if (!flow) return false;
    const done = await flow.run();
    if (!done) return false;
    const result = flow.state.result;
    const text =
      flow.state.kind === 'update'
        ? `Updated ${formatCount(result?.modifiedCount ?? 0)} of ${formatCount(result?.matchedCount ?? 0)} matching documents`
        : `Deleted ${formatCount(result?.deletedCount ?? 0)} documents`;
    await this.run();
    this.#set({ notice: { kind: 'success', text } });
    return true;
  }

  closeBulk(): void {
    this.#bulk = undefined;
    this.#set({ bulk: undefined });
  }

  async dispose(): Promise<void> {
    this.builder.dispose();
    this.#runId++;
    this.#count?.abort();
    await this.#lane.close();
  }
}

/** Subscribes a component to part of a collection view's state. */
export function useCollectionState<T>(
  view: CollectionView,
  selector: (state: CollectionViewState) => T,
): T {
  return useStore(view.store, selector);
}
