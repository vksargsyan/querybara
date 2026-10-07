import { isSqlEngine, newId, type SqlDialect } from '@querybara/core';
import { splitStatements, statementAt } from '@querybara/sql-tools';
import { create } from 'zustand';

import { currentDock } from '../../components/dock';
import { cachedProfile } from '../data';
import { confirm } from '../dialogs';
import { loadSnapshot, metadataCache, useMetadata } from '../metadata';
import { patchPanel, registerPanel, unregisterPanel } from '../panels';
import { switchTarget, type TabTarget } from '../runner';
import { createTab, getTab, patchTab, runtimeOf, useWorkspace } from '../workspace';
import { QueryBuilder, type BuilderTarget } from './builder';
import { builderCatalog, type BuilderCatalog } from './catalog';

/**
 * Query builder panels (spec §8): each is a dock panel with its QueryBuilder, plus a query tab
 * of the same id that the panel never shows as an editor. Run goes through that tab, so the
 * builder's SQL takes the query tabs' path (safety checks, parameters, streaming into the
 * result grid, history, cancel) on a session of the builder's database. Opened from the
 * explorer (a connection, database or schema) or from a SQL tab's statement at the cursor.
 */

interface BuilderPanelsState {
  readonly builders: Readonly<Record<string, QueryBuilder>>;
}

export const useQueryBuilders = create<BuilderPanelsState>()(() => ({ builders: {} }));

const cleanups = new Map<string, () => void>();

/** The catalog of a builder's database, from the metadata cache. */
async function loadCatalog(target: BuilderTarget): Promise<BuilderCatalog> {
  const snapshot = await loadSnapshot(target.profileId, {
    dialect: target.dialect,
    ...(target.database === undefined ? {} : { database: target.database }),
  });
  const facts = metadataCache.facts(target.profileId);
  const connected = target.database === undefined || target.database === facts?.database;
  const schema =
    target.schema ??
    (target.dialect === 'postgres' && connected ? facts?.searchPath?.[0] : undefined);
  return builderCatalog(snapshot, target.dialect, schema);
}

export interface OpenBuilderOptions {
  readonly profileId: string;
  readonly database?: string | undefined;
  readonly schema?: string | undefined;
  /** SQL to open in the builder. */
  readonly sql?: string | undefined;
}

function builderTitle(profileName: string, place: string | undefined): string {
  return place === undefined ? `Query builder (${profileName})` : `Query builder (${place})`;
}

/**
 * Creates a panel's builder on `target`: the runner reads the builder's SQL through the tab's
 * editor handle, and the catalog reloads when the connection's structure changes.
 */
function attachBuilder(id: string, target: BuilderTarget): QueryBuilder {
  cleanups.get(id)?.();
  const builder = new QueryBuilder(target, () => loadCatalog(target));
  runtimeOf(id).editor = {
    getText: () => builder.state.sql,
    cursorOffset: () => 0,
    selection: () => undefined,
    setText: (text) => builder.setSql(text),
    focus: () => undefined,
    format: () => undefined,
  };
  useQueryBuilders.setState((state) => ({ builders: { ...state.builders, [id]: builder } }));
  const offMetadata = useMetadata.subscribe((state, previous) => {
    if (state.versions[target.profileId] !== previous.versions[target.profileId]) {
      void builder.reloadCatalog();
    }
  });
  const offTab = useWorkspace.subscribe((state) => {
    patchPanel(id, { busy: state.tabs[id]?.running === true });
  });
  cleanups.set(id, () => {
    offMetadata();
    offTab();
  });
  return builder;
}

/** Opens a query builder panel for a SQL connection; undefined for other engines. */
export function openQueryBuilder(options: OpenBuilderOptions): string | undefined {
  const profile = cachedProfile(options.profileId);
  if (!profile || !isSqlEngine(profile.engine)) return undefined;
  const dialect: SqlDialect = profile.engine;
  const target: BuilderTarget = {
    profileId: profile.id,
    dialect,
    ...(options.database === undefined ? {} : { database: options.database }),
    ...(options.schema === undefined ? {} : { schema: options.schema }),
  };
  const id = newId();
  const title = builderTitle(profile.name, options.schema ?? options.database);
  registerPanel({ id, kind: 'query-builder', profileId: profile.id, title });
  createTab({
    id,
    profileId: profile.id,
    title,
    ...(options.database === undefined ? {} : { database: options.database }),
  });
  const builder = attachBuilder(id, target);
  void builder.init(options.sql);
  currentDock()?.addPanel({
    id,
    component: 'queryBuilder',
    tabComponent: 'panelTab',
    title,
    params: { panelId: id },
    renderer: 'always',
  });
  return id;
}

/**
 * Moves a builder to another connection or database (the toolbar's selectors): its query tab
 * switches session, and a new builder on the target takes over the canvas. Another dialect
 * starts an empty query, after asking when there is one to lose.
 */
export async function retargetQueryBuilder(panelId: string, next: TabTarget): Promise<void> {
  const previous = queryBuilder(panelId);
  const profile = cachedProfile(next.profileId);
  if (!previous || !profile || !isSqlEngine(profile.engine)) return;
  const dialect: SqlDialect = profile.engine;
  const sameDialect = dialect === previous.target.dialect;
  const { model, sqlSource } = previous.state;
  if (!sameDialect && (model.tables.length > 0 || sqlSource === 'editor')) {
    const ok = await confirm({
      title: 'Start a new query?',
      message: `"${profile.name}" uses another SQL dialect, so the query builder starts over there.`,
      confirmLabel: 'Switch and start over',
    });
    if (!ok) return;
  }
  if (!(await switchTarget(panelId, next))) return;
  const target: BuilderTarget = {
    profileId: profile.id,
    dialect,
    ...(next.database === undefined ? {} : { database: next.database }),
  };
  const title = builderTitle(profile.name, next.database);
  patchTab(panelId, { title });
  patchPanel(panelId, { profileId: profile.id, title });
  currentDock()?.getPanel(panelId)?.api.setTitle(title);
  const builder = attachBuilder(panelId, target);
  void (sameDialect ? builder.carryOver(previous) : builder.init());
}

/**
 * "Open in query builder" from a SQL tab: the selection, or the statement at the cursor, on the
 * tab's connection and database.
 */
export function openQueryBuilderFromTab(tabId: string): string | undefined {
  const tab = getTab(tabId);
  const editor = runtimeOf(tabId).editor;
  const profile = tab && cachedProfile(tab.profileId);
  if (!tab || !editor || !profile || !isSqlEngine(profile.engine)) return undefined;
  const text = editor.getText();
  const selection = editor.selection();
  const sql = selection
    ? text.slice(selection.start, selection.end)
    : statementAt(splitStatements(text, profile.engine), editor.cursorOffset())?.text;
  return openQueryBuilder({
    profileId: tab.profileId,
    ...(tab.database === undefined ? {} : { database: tab.database }),
    ...(sql === undefined ? {} : { sql }),
  });
}

export function queryBuilder(panelId: string): QueryBuilder | undefined {
  return useQueryBuilders.getState().builders[panelId];
}

/** Frees a closed panel's builder; the dock closes its query tab (and session) itself. */
export function disposeQueryBuilder(panelId: string): void {
  cleanups.get(panelId)?.();
  cleanups.delete(panelId);
  useQueryBuilders.setState((state) => {
    const { [panelId]: _gone, ...builders } = state.builders;
    return { builders };
  });
  unregisterPanel(panelId);
}
