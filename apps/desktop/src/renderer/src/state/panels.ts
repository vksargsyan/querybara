import { create } from 'zustand';

/**
 * Dock panels other than query tabs: table data views and table designers. The dock lays them
 * out; this store names them for their tab headers, marks unsaved work, and tells the window
 * which connection the active panel belongs to (the production frame follows it, spec §4).
 */

export type PanelKind =
  | 'table-data'
  | 'table-designer'
  | 'redis'
  | 'mongo'
  | 'sync'
  | 'server-tools'
  | 'search'
  | 'query-builder'
  | 'er-diagram'
  | 'schedules'
  | 'redis-dump'
  | 'objects'
  | 'keybindings';

export interface PanelInfo {
  readonly id: string;
  readonly kind: PanelKind;
  readonly profileId: string;
  readonly title: string;
  /**
   * Where on the connection the panel points (a database, "database.schema"), for its tab's
   * tooltip; unset when the panel is not in one database (a cluster tool, the connection's own).
   */
  readonly database?: string | undefined;
  /** Identifies what the panel shows (a table), so opening it again focuses this panel. */
  readonly key?: string;
  /** Staged changes or unsaved design: closing asks first. */
  readonly dirty: boolean;
  readonly busy: boolean;
}

interface PanelsState {
  readonly panels: Readonly<Record<string, PanelInfo>>;
}

export const usePanels = create<PanelsState>()(() => ({ panels: {} }));

export function registerPanel(info: Omit<PanelInfo, 'dirty' | 'busy'>): void {
  usePanels.setState((state) => ({
    panels: { ...state.panels, [info.id]: { ...info, dirty: false, busy: false } },
  }));
}

export function patchPanel(id: string, patch: Partial<Omit<PanelInfo, 'id' | 'kind'>>): void {
  usePanels.setState((state) => {
    const current = state.panels[id];
    if (!current) return state;
    const next = { ...current, ...patch };
    if (
      next.title === current.title &&
      next.dirty === current.dirty &&
      next.busy === current.busy &&
      next.profileId === current.profileId &&
      next.database === current.database &&
      next.key === current.key
    ) {
      return state;
    }
    return { panels: { ...state.panels, [id]: next } };
  });
}

export function unregisterPanel(id: string): void {
  usePanels.setState((state) => {
    const { [id]: _removed, ...panels } = state.panels;
    return { panels };
  });
}

export function panelInfo(id: string): PanelInfo | undefined {
  return usePanels.getState().panels[id];
}

/** The open panel showing `key`, if any. */
export function panelWithKey(key: string): PanelInfo | undefined {
  return Object.values(usePanels.getState().panels).find((panel) => panel.key === key);
}

/**
 * How a tab names a table's place: its database on MySQL/MariaDB (where the schema is the
 * database), "database.schema" on PostgreSQL.
 */
export function placeOf(
  database: string | undefined,
  schema: string | undefined,
): string | undefined {
  if (schema === undefined || schema === '') return database;
  return database === undefined || database === '' || database === schema
    ? schema
    : `${database}.${schema}`;
}

/** The key of a table's data view or designer (see `PanelInfo.key`). */
export function panelKey(
  kind: 'data' | 'design',
  table: {
    readonly profileId: string;
    readonly database: string | undefined;
    readonly schema: string;
    readonly name: string;
  },
): string {
  return [kind, table.profileId, table.database ?? '', table.schema, table.name].join('\u0000');
}
