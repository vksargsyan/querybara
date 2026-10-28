import { QuerybaraError, newId } from '@querybara/core';
import {
  formatShell,
  fromEjson,
  locationAt,
  splitScript,
  statementAt,
  type Namespace,
  type ShellCursorQuery,
  type ShellEvent,
  type ShellValue,
} from '@querybara/mongo-tools';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';

import { errorInfo, errorMessage } from '../../lib/errors';
import type { HostClient } from '../../lib/main-client';
import { mainApi } from '../../lib/main-client';
import { connect } from '../connections';
import { profileById, queryClient } from '../data';
import { askShell } from '../dialogs';
import { loadChildren, pathKey, useExplorer } from '../explorer';
import { patchPanel } from '../panels';
import { SessionLane } from '../session-lane';
import { DocumentResults, type ResultMode } from './results';

/**
 * IntelliShell (ADR 0036): Studio 3T's mongosh tab. The script runs in an embedded mongosh in
 * the connection host (a worker thread with its own connection), a statement at a time. Raw
 * shell output collects what mongosh prints; with Query Assist on, each find() or aggregate()
 * gets a result tab of its own ("Find Query (line 3)"), with the tree, table and JSON views and
 * its documents' exact BSON types, paged on demand. Unpinned result tabs make way for the next
 * run's. Runs go to the query history; the write rules ask through the app's dialogs.
 */

export interface IntelliShellTarget {
  readonly profileId: string;
  /** The database `db` starts in; the connection's default when undefined. */
  readonly database: string | undefined;
  readonly text?: string;
  /** Runs the text once the shell is up (Collection Statistics and the like). */
  readonly run?: boolean;
}

/** How much of the editor a run takes: everything, the statement at the cursor, the selection. */
export type RunMode = 'all' | 'statement' | 'selection';

export interface ShellOutputLine {
  readonly id: string;
  /** `input`: a statement that ran; `info`: the shell's own notes. */
  readonly kind: 'input' | 'output' | 'print' | 'error' | 'info';
  readonly text: string;
}

/** A result tab: one cursor (a find, an aggregate, a command) and its documents. */
export interface ShellTab {
  readonly id: string;
  readonly title: string;
  /** The editor line the statement started on. */
  readonly line: number;
  readonly source: string;
  readonly cursorType: 'find' | 'aggregate' | 'command' | 'changeStream';
  /** The host's cursor, until it is read to the end or the tab closes. */
  readonly resultId: string | undefined;
  readonly ns: Namespace | undefined;
  readonly query: ShellCursorQuery | undefined;
  readonly exactTypes: boolean;
  readonly pinned: boolean;
  readonly durationMs: number;
  readonly results: DocumentResults;
}

export interface IntelliShellState {
  readonly text: string;
  readonly status: 'opening' | 'ready' | 'failed';
  readonly error: string | undefined;
  readonly database: string | undefined;
  readonly databases: readonly string[];
  readonly mongoshVersion: string | undefined;
  readonly serverVersion: string | undefined;
  readonly running: boolean;
  readonly stopping: boolean;
  readonly output: readonly ShellOutputLine[];
  readonly tabs: readonly ShellTab[];
  /** `raw` (the raw shell output) or a result tab's id. */
  readonly active: string;
  /** Query Assist: find() and aggregate() results open as tabs; off, they print as text. */
  readonly queryAssist: boolean;
  /** New result tabs are pinned (kept by the next run). */
  readonly pinNew: boolean;
  /** Editor above the results, or beside them. */
  readonly layout: 'stacked' | 'side';
  /** Where the last error points in the editor. */
  readonly errorMarker:
    { readonly offset: number; readonly end?: number; readonly message: string } | undefined;
  readonly lastRun:
    | {
        readonly status: 'success' | 'error' | 'cancelled';
        readonly durationMs: number;
        readonly ran: number;
      }
    | undefined;
  readonly readOnlyProfile: boolean;
  readonly production: boolean;
  /** The script file the editor was opened from or saved to. */
  readonly filePath: string | undefined;
}

/** Documents in a result tab's first page and each page after. */
export const SHELL_PAGE_SIZE = 100;

const OUTPUT_LIMIT = 5000;

const TAB_TITLES: Readonly<Record<ShellTab['cursorType'], string>> = {
  find: 'Find Query',
  aggregate: 'Aggregate Query',
  command: 'Command',
  changeStream: 'Change Stream',
};

/** The text of an error event as mongosh shows it ("MongoServerError[Unauthorized]: …"). */
export function errorText(event: Extract<ShellEvent, { type: 'error' }>): string {
  const name =
    event.name !== undefined && event.name !== 'Error' && !event.message.startsWith(event.name)
      ? `${event.name}${event.codeName !== undefined ? `[${event.codeName}]` : ''}: `
      : '';
  return `${name}${event.message}`;
}

/** Documents as raw shell output prints them. */
export function documentsText(documents: readonly string[]): string {
  return documents.map((document) => formatShell(fromEjson(document, 'document'))).join('\n');
}

/** The first line of a statement, for the "> …" input line of the raw output. */
export function inputText(source: string): string {
  const lines = source.trim().split('\n');
  return lines.length > 1 ? `${lines[0]!.trimEnd()} …` : lines[0]!;
}

/**
 * The part of the editor a run takes, and where it starts: the selection (or, when nothing is
 * selected, the fallback), the statement at the cursor, or everything.
 */
export function runScope(
  text: string,
  mode: RunMode,
  editor: { readonly cursor: number; readonly selection?: { start: number; end: number } },
): { readonly script: string; readonly base: number } {
  const selection = editor.selection;
  if (mode === 'selection' && selection && selection.end > selection.start) {
    return { script: text.slice(selection.start, selection.end), base: selection.start };
  }
  if (mode === 'statement' || mode === 'selection') {
    try {
      const statement = statementAt(splitScript(text), editor.cursor);
      if (statement) return { script: statement.text, base: statement.start };
    } catch {
      // A script that does not parse runs whole, so the shell reports where.
    }
  }
  return { script: text, base: 0 };
}

export class IntelliShell {
  readonly id: string;
  readonly target: IntelliShellTarget;
  readonly store: StoreApi<IntelliShellState>;
  /** A session of its own, for sampling field names (autocompletion). */
  readonly #lane: SessionLane;
  #host: HostClient | undefined;
  #generation: number | undefined;
  #shellId: string | undefined;
  #opening: Promise<{ host: HostClient; shellId: string }> | undefined;
  #disposed = false;
  readonly #fields = new Map<string, Promise<readonly string[]>>();
  #profileName = '';

  constructor(id: string, target: IntelliShellTarget) {
    this.id = id;
    this.target = target;
    this.store = createStore<IntelliShellState>()(() => ({
      text: target.text ?? '',
      status: 'opening',
      error: undefined,
      database: target.database,
      databases: target.database ? [target.database] : [],
      mongoshVersion: undefined,
      serverVersion: undefined,
      running: false,
      stopping: false,
      output: [],
      tabs: [],
      active: 'raw',
      queryAssist: true,
      pinNew: false,
      layout: 'stacked',
      errorMarker: undefined,
      lastRun: undefined,
      readOnlyProfile: false,
      production: false,
      filePath: undefined,
    }));
    this.#lane = new SessionLane(target.profileId, target.database);
  }

  get state(): IntelliShellState {
    return this.store.getState();
  }

  #set(patch: Partial<IntelliShellState>): void {
    this.store.setState(patch);
  }

  #print(kind: ShellOutputLine['kind'], text: string): void {
    const output = [...this.state.output, { id: newId(), kind, text }];
    this.#set({ output: output.length > OUTPUT_LIMIT ? output.slice(-OUTPUT_LIMIT) : output });
  }

  /** Reads the profile's rules and the databases, and starts the shell. */
  async init(): Promise<void> {
    const profile = await profileById(this.target.profileId);
    if (profile) {
      this.#profileName = profile.name;
      this.#set({
        readOnlyProfile: profile.presentation.readOnly,
        production: profile.presentation.environment === 'production',
      });
    }
    void this.#loadDatabases();
    try {
      await this.#ensure();
    } catch {
      // #ensure reported it; the next run tries again.
      return;
    }
    if (this.target.run && this.state.text.trim() !== '') await this.run('all');
  }

  async #loadDatabases(): Promise<void> {
    try {
      await loadChildren(this.target.profileId, []);
      const nodes =
        useExplorer.getState().children[this.target.profileId]?.[pathKey([])]?.nodes ?? [];
      const databases = nodes.filter((node) => node.kind === 'database').map((node) => node.name);
      if (databases.length > 0) this.#set({ databases });
    } catch {
      // The list is a convenience: `use` reaches any database.
    }
  }

  /** The open shell on the live connection, opening one (again) when there is none. */
  async #ensure(): Promise<{ host: HostClient; shellId: string }> {
    if (this.#disposed) {
      throw new QuerybaraError({ code: 'CANCELLED', message: 'IntelliShell was closed' });
    }
    const connection = await connect(this.target.profileId);
    const host = connection.host;
    if (!host) throw new QuerybaraError({ code: 'CONNECTION_FAILED', message: 'Not connected' });
    if (
      this.#shellId !== undefined &&
      this.#host === host &&
      this.#generation === connection.generation
    ) {
      return { host, shellId: this.#shellId };
    }
    this.#opening ??= (async () => {
      this.#set({ status: 'opening', error: undefined });
      try {
        const database = this.state.database;
        const { shellId, info } = await host.mongo.shell.open(
          database === undefined ? {} : { database },
        );
        if (this.#disposed) {
          await host.mongo.shell.close({ shellId }).catch(() => undefined);
          throw new QuerybaraError({ code: 'CANCELLED', message: 'IntelliShell was closed' });
        }
        const first = this.state.mongoshVersion === undefined;
        this.#host = host;
        this.#generation = connection.generation;
        this.#shellId = shellId;
        this.#set({
          status: 'ready',
          database: info.database,
          databases: [...new Set([info.database, ...this.state.databases])],
          mongoshVersion: info.mongoshVersion,
          serverVersion: info.serverVersion,
        });
        patchPanel(this.id, { database: info.database });
        if (first) {
          this.#print(
            'info',
            `mongosh ${info.mongoshVersion} (embedded) · MongoDB ${info.serverVersion} · ${info.database}`,
          );
        } else {
          this.#print('info', 'A new shell started: earlier variables are gone');
        }
        return { host, shellId };
      } catch (error) {
        this.#set({ status: 'failed', error: errorMessage(error) });
        throw error;
      } finally {
        this.#opening = undefined;
      }
    })();
    return this.#opening;
  }

  setText(text: string): void {
    this.#set({ text, errorMarker: undefined });
  }

  /**
   * Runs the editor's text, the statement at its cursor or its selection (offsets in `text`).
   * Unpinned result tabs make way for this run's.
   */
  async run(
    mode: RunMode,
    editor: { readonly cursor: number; readonly selection?: { start: number; end: number } } = {
      cursor: 0,
    },
  ): Promise<void> {
    if (this.state.running) return;
    const text = this.state.text;
    const { script, base } = runScope(text, mode, editor);
    if (script.trim() === '') return;
    this.#set({ running: true, stopping: false, errorMarker: undefined });
    patchPanel(this.id, { busy: true });
    await this.#dropUnpinned();
    const started = performance.now();
    let status: 'success' | 'error' | 'cancelled' = 'success';
    let failure: string | undefined;
    let documents = 0;
    try {
      const { host, shellId } = await this.#ensure();
      const raw = new Map<string, true>();
      for await (const event of host.mongo.shell.evaluate({ shellId, script })) {
        documents += await this.#apply(event, { host, shellId, text, base, raw });
        if (event.type === 'end') {
          status = event.status;
          this.#set({
            lastRun: { status: event.status, durationMs: event.durationMs, ran: event.ran },
          });
        } else if (event.type === 'error') {
          failure = errorText(event);
        }
      }
    } catch (error) {
      const info = errorInfo(error);
      status = info.code === 'CANCELLED' ? 'cancelled' : 'error';
      failure = errorMessage(error);
      this.#print('error', failure);
      this.#set({ active: 'raw' });
      if (info.code === 'NOT_FOUND') this.#shellId = undefined;
    } finally {
      this.#set({ running: false, stopping: false });
      patchPanel(this.id, { busy: false });
    }
    await this.#record(script, status, failure, Math.round(performance.now() - started), documents);
  }

  /** Applies one event; returns how many documents it showed. */
  async #apply(
    event: ShellEvent,
    run: {
      readonly host: HostClient;
      readonly shellId: string;
      readonly text: string;
      readonly base: number;
      /** Cursors printed to the raw output (Query Assist off): `it` pages them there too. */
      readonly raw: Map<string, true>;
    },
  ): Promise<number> {
    switch (event.type) {
      case 'statement':
        this.#print(
          'input',
          `> ${inputText(run.text.slice(run.base + event.start, run.base + event.end))}`,
        );
        return 0;
      case 'print':
        this.#print(event.stream === 'error' ? 'error' : 'print', event.text);
        return 0;
      case 'result':
        return this.#showValue(event.value, {
          ...run,
          line: locationAt(run.text, run.base + event.start).line,
          source: event.source,
          durationMs: event.durationMs,
        });
      case 'more': {
        const tab = this.state.tabs.find((t) => t.resultId === event.resultId);
        if (tab) {
          tab.results.append(event.documents, event.hasMore);
          if (!event.hasMore) this.#patchTab(tab.id, { resultId: undefined });
          this.#set({ active: tab.id });
        } else {
          this.#print('output', documentsText(event.documents));
          if (event.hasMore) this.#print('info', 'Type "it" for more');
        }
        return event.documents.length;
      }
      case 'error': {
        const message = errorText(event);
        this.#print('error', message);
        const start = event.position ?? (event.statement ? event.statement.start : undefined);
        if (start !== undefined) {
          this.#set({
            errorMarker: {
              offset: run.base + start,
              ...(event.position === undefined && event.statement
                ? { end: run.base + event.statement.end }
                : {}),
              message,
            },
          });
        }
        this.#set({ active: 'raw' });
        return 0;
      }
      case 'prompt': {
        const answer = await askShell(
          {
            kind: event.kind,
            question: event.question,
            ...(event.operation !== undefined ? { operation: event.operation } : {}),
          },
          { connectionName: this.#profileName, production: this.state.production },
        );
        await run.host.mongo.shell
          .answer({ shellId: run.shellId, promptId: event.promptId, answer })
          .catch(() => undefined);
        return 0;
      }
      case 'database':
        this.#set({
          database: event.name,
          databases: [...new Set([event.name, ...this.state.databases])],
        });
        patchPanel(this.id, { database: event.name });
        return 0;
      case 'clear':
        this.#set({ output: [] });
        return 0;
      case 'end':
        return 0;
    }
  }

  #showValue(
    value: ShellValue,
    context: {
      readonly host: HostClient;
      readonly shellId: string;
      readonly line: number;
      readonly source: string;
      readonly durationMs: number;
    },
  ): number {
    switch (value.kind) {
      case 'none':
        return 0;
      case 'text':
        this.#print('output', value.text);
        return 0;
      case 'documents':
        this.#print('output', documentsText(value.documents));
        return value.documents.length;
      case 'cursor': {
        if (!this.state.queryAssist) {
          this.#print('output', documentsText(value.documents));
          if (value.hasMore) this.#print('info', 'Type "it" for more');
          return value.documents.length;
        }
        const results = new DocumentResults({ mode: 'table' });
        const tab: ShellTab = {
          id: newId(),
          title: `${TAB_TITLES[value.cursorType]} (line ${context.line})`,
          line: context.line,
          source: context.source,
          cursorType: value.cursorType,
          resultId: value.hasMore ? value.resultId : undefined,
          ns: value.ns,
          query: value.query,
          exactTypes: value.exactTypes,
          pinned: this.state.pinNew,
          durationMs: context.durationMs,
          results,
        };
        results.begin(() => this.fetchMore(tab.id));
        results.append(value.documents, value.hasMore);
        this.#print(
          'info',
          `${value.documents.length}${value.hasMore ? '+' : ''} ${value.documents.length === 1 ? 'document' : 'documents'} in "${tab.title}"`,
        );
        this.#set({ tabs: [...this.state.tabs, tab], active: tab.id });
        return value.documents.length;
      }
    }
  }

  #patchTab(id: string, patch: Partial<Omit<ShellTab, 'id' | 'results'>>): void {
    this.#set({ tabs: this.state.tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)) });
  }

  /** The next page of a result tab's cursor. */
  async fetchMore(tabId: string): Promise<void> {
    const tab = this.state.tabs.find((t) => t.id === tabId);
    if (!tab || tab.resultId === undefined) return;
    tab.results.setLoading(true);
    try {
      const { host, shellId } = await this.#ensure();
      const page = await host.mongo.shell.more({
        shellId,
        resultId: tab.resultId,
        count: SHELL_PAGE_SIZE,
      });
      tab.results.append(page.documents, page.hasMore);
      if (!page.hasMore) this.#patchTab(tab.id, { resultId: undefined });
    } catch (error) {
      tab.results.fail(errorMessage(error));
      this.#patchTab(tab.id, { resultId: undefined });
    }
  }

  async #closeCursor(tab: ShellTab): Promise<void> {
    const shellId = this.#shellId;
    if (tab.resultId === undefined || shellId === undefined || !this.#host) return;
    await this.#host.mongo.shell
      .closeResult({ shellId, resultId: tab.resultId })
      .catch(() => undefined);
  }

  async #dropUnpinned(): Promise<void> {
    const dropped = this.state.tabs.filter((tab) => !tab.pinned);
    if (dropped.length === 0) return;
    const tabs = this.state.tabs.filter((tab) => tab.pinned);
    this.#set({
      tabs,
      active: tabs.some((tab) => tab.id === this.state.active) ? this.state.active : 'raw',
    });
    await Promise.all(dropped.map((tab) => this.#closeCursor(tab)));
  }

  async closeTab(tabId: string): Promise<void> {
    const tab = this.state.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const tabs = this.state.tabs.filter((t) => t.id !== tabId);
    this.#set({ tabs, active: this.state.active === tabId ? 'raw' : this.state.active });
    await this.#closeCursor(tab);
  }

  togglePin(tabId: string): void {
    const tab = this.state.tabs.find((t) => t.id === tabId);
    if (tab) this.#patchTab(tabId, { pinned: !tab.pinned });
  }

  setActive(active: string): void {
    this.#set({ active });
  }

  setMode(mode: ResultMode): void {
    const tab = this.state.tabs.find((t) => t.id === this.state.active);
    tab?.results.setMode(mode);
  }

  setQueryAssist(queryAssist: boolean): void {
    this.#set({ queryAssist });
  }

  setPinNew(pinNew: boolean): void {
    this.#set({ pinNew });
  }

  toggleLayout(): void {
    this.#set({ layout: this.state.layout === 'stacked' ? 'side' : 'stacked' });
  }

  clearOutput(): void {
    this.#set({ output: [] });
  }

  /** Stops the running script; the shell restarts when it does not stop in time. */
  async stop(): Promise<void> {
    const shellId = this.#shellId;
    if (!this.state.running || shellId === undefined || !this.#host) return;
    this.#set({ stopping: true });
    await this.#host.mongo.shell.interrupt({ shellId }).catch(() => undefined);
  }

  /** A new shell in the same database: variables and open result cursors are gone. */
  async restart(): Promise<void> {
    try {
      const { host, shellId } = await this.#ensure();
      const info = await host.mongo.shell.restart({ shellId });
      this.#set({ database: info.database });
      for (const tab of this.state.tabs) {
        if (tab.resultId !== undefined) this.#patchTab(tab.id, { resultId: undefined });
      }
      this.#print('info', 'The shell was restarted: earlier variables are gone');
    } catch (error) {
      this.#print('error', errorMessage(error));
    }
  }

  /** Switches the database `db` stands for (the breadcrumb's database list). */
  async useDatabase(database: string): Promise<void> {
    if (this.state.running) return;
    this.#set({ database });
    patchPanel(this.id, { database });
    try {
      const { host, shellId } = await this.#ensure();
      const info = await host.mongo.shell.useDatabase({ shellId, database });
      this.#print('info', `switched to db ${info.database}`);
    } catch (error) {
      this.#print('error', errorMessage(error));
    }
  }

  /** mongosh's completions for a statement's text up to the cursor. */
  async complete(text: string): Promise<readonly string[]> {
    if (this.state.running || this.#shellId === undefined) return [];
    try {
      const { host, shellId } = await this.#ensure();
      return (await host.mongo.shell.complete({ shellId, text })).completions;
    } catch {
      return [];
    }
  }

  /** Field names of a collection, from a small sample (cached for the tab's life). */
  fields(db: string, collection: string): Promise<readonly string[]> {
    const key = `${db}\u0000${collection}`;
    let found = this.#fields.get(key);
    if (!found) {
      found = this.#lane
        .run(async (host, sessionId) => {
          const analysis = await host.mongo.analyzeSchema({
            sessionId,
            ns: { db, collection },
            options: { sampleSize: 200 },
          });
          // Array elements share their array's query path ("tags[]" queries as "tags").
          return [...new Set(analysis.fields.map((field) => field.queryPath))];
        })
        .catch(() => []);
      this.#fields.set(key, found);
    }
    return found;
  }

  /** Collections of a database, from the side bar's tree. */
  collections(db: string): readonly string[] {
    const children = useExplorer.getState().children[this.target.profileId] ?? {};
    const names = new Set<string>();
    for (const folder of ['collections', 'views', 'time-series']) {
      for (const node of children[pathKey([db, folder])]?.nodes ?? []) names.add(node.name);
    }
    return [...names];
  }

  /** Opens a script file into the editor. */
  async openFile(): Promise<void> {
    const { path } = await mainApi().dialogs.openFile({
      title: 'Open script',
      filters: [{ name: 'Scripts', extensions: ['js', 'mongodb', 'txt'] }],
    });
    if (path === null) return;
    const { text } = await mainApi().dialogs.readFile({ path });
    this.#set({ text, filePath: path, errorMarker: undefined });
  }

  /** Saves the editor to its file, or asks where (`as`, or when it has none). */
  async saveFile(as = false): Promise<void> {
    let path = as ? undefined : this.state.filePath;
    if (path !== undefined) {
      try {
        await mainApi().dialogs.writeFile({ path, text: this.state.text });
        return;
      } catch {
        // A file opened (not saved) in this window may not be written: ask where instead.
      }
    }
    const picked = await mainApi().dialogs.saveFile({
      title: 'Save script',
      defaultName: 'script.js',
      filters: [{ name: 'Scripts', extensions: ['js'] }],
    });
    if (picked.path === null) return;
    path = picked.path;
    await mainApi().dialogs.writeFile({ path, text: this.state.text });
    this.#set({ filePath: path });
  }

  async #record(
    text: string,
    status: 'success' | 'error' | 'cancelled',
    error: string | undefined,
    durationMs: number,
    rowCount: number,
  ): Promise<void> {
    try {
      await mainApi().history.add({
        profileId: this.target.profileId,
        database: this.state.database ?? null,
        text,
        status,
        error: error ?? null,
        durationMs,
        rowCount,
      });
      await queryClient.invalidateQueries({ queryKey: ['history'] });
    } catch {
      // History is best effort: a run never fails because it could not be recorded.
    }
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    const shellId = this.#shellId;
    const host = this.#host;
    this.#shellId = undefined;
    if (shellId !== undefined && host) {
      await host.mongo.shell.close({ shellId }).catch(() => undefined);
    }
    await this.#lane.close();
  }
}

/** Subscribes a component to part of an IntelliShell's state. */
export function useIntelliShell<T>(
  shell: IntelliShell,
  selector: (state: IntelliShellState) => T,
): T {
  return useStore(shell.store, selector);
}
