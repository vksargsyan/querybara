import { isSqlEngine, type EngineId } from '@querybara/core';

import type { IconName } from '../icon-names';

/**
 * The connection toolbar's buttons for each engine (ADR 0042, trimmed by ADR 0043). Each is a
 * command (state/commands.ts), so it acts on what is in front and shows in the palette with its
 * key. The toolbar keeps the connection's tools reached for most; the rest stay in the
 * connection's menu, the explorer's menus and the palette, and New connection in the side bar's
 * actions. Buttons come in labelled groups, each icon in a Kiln glaze.
 */

/** A Kiln glaze (styles.css): the icon's colour. */
export type ToolTone = 'rust' | 'cobalt' | 'celadon' | 'ochre' | 'lilac' | 'peach' | 'teal';

export interface Tool {
  readonly command: string;
  /** Short enough for the toolbar's fixed button width (one word, or two short ones). */
  readonly label: string;
  readonly icon: IconName;
  readonly tone: ToolTone;
}

/** A run of buttons between separators, with its label above it. */
export interface ToolGroup {
  readonly label: string;
  readonly tools: readonly Tool[];
}

export type ToolbarKind = 'sql' | 'mongodb' | 'redis' | 'elasticsearch';

export function toolbarKind(engine: EngineId): ToolbarKind {
  if (isSqlEngine(engine)) return 'sql';
  return engine;
}

const TASKS: Tool = { command: 'tools.schedules', label: 'Tasks', icon: 'schedule', tone: 'ochre' };

const SAVED: Tool = {
  command: 'sync.savedComparisons',
  label: 'Saved',
  icon: 'bookmark',
  tone: 'ochre',
};

export const TOOLBARS: Readonly<Record<ToolbarKind, readonly ToolGroup[]>> = {
  sql: [
    {
      label: 'Query',
      tools: [
        { command: 'sql.newQuery', label: 'Query', icon: 'query', tone: 'cobalt' },
        { command: 'sql.queryBuilder', label: 'Builder', icon: 'builder', tone: 'lilac' },
      ],
    },
    {
      label: 'Objects',
      tools: [
        { command: 'sql.openTable', label: 'Table', icon: 'table', tone: 'teal' },
        { command: 'sql.erDiagram', label: 'ER Diagram', icon: 'diagram', tone: 'peach' },
      ],
    },
    {
      label: 'Data',
      tools: [
        { command: 'sql.import', label: 'Import', icon: 'import', tone: 'celadon' },
        { command: 'sql.export', label: 'Export', icon: 'export', tone: 'rust' },
      ],
    },
    {
      label: 'Compare',
      tools: [
        { command: 'sql.compareStructure', label: 'Structure', icon: 'compare', tone: 'lilac' },
        { command: 'sql.compareData', label: 'Data', icon: 'compare-rows', tone: 'cobalt' },
        SAVED,
      ],
    },
    {
      label: 'Tools',
      tools: [
        { command: 'sql.serverMonitor', label: 'Monitor', icon: 'gauge', tone: 'rust' },
        TASKS,
      ],
    },
  ],
  mongodb: [
    {
      label: 'Query',
      tools: [
        { command: 'mongo.openCollection', label: 'Collection', icon: 'table', tone: 'teal' },
        { command: 'mongo.openIntelliShell', label: 'IntelliShell', icon: 'shell', tone: 'cobalt' },
        { command: 'mongo.openAggregation', label: 'Aggregate', icon: 'filter', tone: 'lilac' },
      ],
    },
    {
      label: 'Data',
      tools: [
        { command: 'mongo.import', label: 'Import', icon: 'import', tone: 'celadon' },
        { command: 'mongo.export', label: 'Export', icon: 'export', tone: 'rust' },
      ],
    },
    {
      label: 'Compare',
      tools: [
        { command: 'mongo.compare', label: 'Structure', icon: 'compare', tone: 'lilac' },
        { command: 'mongo.compareData', label: 'Data', icon: 'compare-rows', tone: 'cobalt' },
        SAVED,
      ],
    },
    {
      label: 'Tools',
      tools: [
        { command: 'mongo.analyzeSchema', label: 'Schema', icon: 'chart', tone: 'peach' },
        { command: 'mongo.serverStatus', label: 'Monitor', icon: 'gauge', tone: 'rust' },
        TASKS,
      ],
    },
  ],
  redis: [
    {
      label: 'Data',
      tools: [
        { command: 'redis.keys', label: 'Keys', icon: 'key', tone: 'teal' },
        { command: 'redis.cli', label: 'CLI', icon: 'shell', tone: 'cobalt' },
        { command: 'redis.pubsub', label: 'Pub/Sub', icon: 'link', tone: 'lilac' },
      ],
    },
    {
      label: 'Server',
      tools: [
        { command: 'redis.dashboard', label: 'Dashboard', icon: 'gauge', tone: 'rust' },
        { command: 'redis.slowlog', label: 'Slow Log', icon: 'history', tone: 'peach' },
        { command: 'redis.clients', label: 'Clients', icon: 'plug', tone: 'celadon' },
      ],
    },
    { label: 'Tools', tools: [TASKS] },
  ],
  elasticsearch: [
    {
      label: 'Query',
      tools: [
        { command: 'search.console', label: 'Console', icon: 'shell', tone: 'cobalt' },
        { command: 'search.sql', label: 'SQL', icon: 'query', tone: 'lilac' },
      ],
    },
    {
      label: 'Data',
      tools: [
        { command: 'search.documents', label: 'Documents', icon: 'table', tone: 'teal' },
        { command: 'search.index', label: 'Index', icon: 'settings', tone: 'peach' },
      ],
    },
    {
      label: 'Server',
      tools: [
        { command: 'search.cluster', label: 'Cluster', icon: 'server', tone: 'rust' },
        { command: 'search.snapshots', label: 'Snapshots', icon: 'archive', tone: 'ochre' },
      ],
    },
  ],
};
