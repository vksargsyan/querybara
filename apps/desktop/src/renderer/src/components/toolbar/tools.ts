import { isSqlEngine, type EngineId } from '@querybara/core';

import type { IconName } from '../icon-names';

/**
 * The connection toolbar's buttons for each engine (ADR 0042). Each is a command
 * (state/commands.ts), so it acts on what is in front and shows in the palette with its key.
 * MongoDB keeps Studio 3T's set (ADR 0036); the SQL engines, Redis and Elasticsearch get the
 * same shape from the tools their explorer menus already open.
 */

export interface Tool {
  readonly command: string;
  readonly label: string;
  readonly icon: IconName;
}

export type ToolbarKind = 'sql' | 'mongodb' | 'redis' | 'elasticsearch';

export function toolbarKind(engine: EngineId): ToolbarKind {
  if (isSqlEngine(engine)) return 'sql';
  return engine;
}

const CONNECT: readonly Tool[] = [
  { command: 'connection.new', label: 'Connect', icon: 'connection-new' },
];

const TASKS: Tool = { command: 'tools.schedules', label: 'Tasks', icon: 'schedule' };

export const TOOLBARS: Readonly<Record<ToolbarKind, readonly (readonly Tool[])[]>> = {
  sql: [
    CONNECT,
    [
      { command: 'sql.newQuery', label: 'Query', icon: 'query' },
      { command: 'sql.queryBuilder', label: 'Builder', icon: 'builder' },
      { command: 'sql.runSqlFile', label: 'SQL File', icon: 'file-run' },
      { command: 'query.history', label: 'History', icon: 'history' },
    ],
    [
      { command: 'sql.openTable', label: 'Table', icon: 'table' },
      { command: 'sql.newTable', label: 'New Table', icon: 'table-new' },
      { command: 'sql.newDatabase', label: 'New Database', icon: 'database' },
      { command: 'sql.erDiagram', label: 'ER Diagram', icon: 'diagram' },
    ],
    [
      { command: 'sql.import', label: 'Import', icon: 'import' },
      { command: 'sql.export', label: 'Export', icon: 'export' },
      { command: 'sql.transfer', label: 'Transfer', icon: 'transfer' },
      { command: 'sql.backup', label: 'Backup', icon: 'archive' },
      { command: 'sql.restore', label: 'Restore', icon: 'restore' },
    ],
    [
      { command: 'sql.compareStructure', label: 'Compare', icon: 'compare' },
      { command: 'sql.compareData', label: 'Data Compare', icon: 'compare-rows' },
      TASKS,
    ],
    [
      { command: 'sql.serverMonitor', label: 'Monitor', icon: 'gauge' },
      { command: 'sql.sessions', label: 'Sessions', icon: 'pulse' },
      { command: 'sql.topQueries', label: 'Top Queries', icon: 'chart' },
      { command: 'sql.users', label: 'Users', icon: 'users' },
      { command: 'sql.maintenance', label: 'Maintenance', icon: 'wrench' },
    ],
  ],
  mongodb: [
    CONNECT,
    [
      { command: 'mongo.openCollection', label: 'Collection', icon: 'table' },
      { command: 'mongo.openIntelliShell', label: 'IntelliShell', icon: 'shell' },
      { command: 'mongo.openSql', label: 'SQL', icon: 'query' },
      { command: 'mongo.openAggregation', label: 'Aggregate', icon: 'filter' },
      { command: 'mongo.profiler', label: 'Query Profiler', icon: 'history' },
    ],
    [
      { command: 'mongo.export', label: 'Export', icon: 'export' },
      { command: 'mongo.import', label: 'Import', icon: 'import' },
    ],
    [
      { command: 'mongo.compare', label: 'Compare', icon: 'compare' },
      { command: 'mongo.analyzeSchema', label: 'Schema', icon: 'chart' },
      { command: 'mongo.reschema', label: 'Reschema', icon: 'design' },
      { command: 'mongo.mask', label: 'Masking', icon: 'eye-off' },
      { command: 'mongo.generate', label: 'Generate', icon: 'table-new' },
      { command: 'mongo.transfer', label: 'Transfer', icon: 'transfer' },
      TASKS,
    ],
    [
      { command: 'mongo.manageUsers', label: 'Users', icon: 'users' },
      { command: 'mongo.manageRoles', label: 'Roles', icon: 'key' },
      { command: 'mongo.serverStatus', label: 'Server Status', icon: 'gauge' },
    ],
  ],
  redis: [
    CONNECT,
    [
      { command: 'redis.keys', label: 'Keys', icon: 'key' },
      { command: 'redis.cli', label: 'CLI', icon: 'shell' },
      { command: 'redis.pubsub', label: 'Pub/Sub', icon: 'link' },
      { command: 'redis.search', label: 'Search', icon: 'search' },
    ],
    [
      { command: 'redis.dashboard', label: 'Dashboard', icon: 'gauge' },
      { command: 'redis.slowlog', label: 'Slow Log', icon: 'history' },
      { command: 'redis.clients', label: 'Clients', icon: 'plug' },
      { command: 'redis.latency', label: 'Latency', icon: 'pulse' },
      { command: 'redis.monitor', label: 'Monitor', icon: 'server' },
      { command: 'redis.bigkeys', label: 'Big Keys', icon: 'chart' },
    ],
    [
      { command: 'redis.config', label: 'Config', icon: 'settings' },
      { command: 'redis.acl', label: 'ACL', icon: 'users' },
      { command: 'redis.topology', label: 'Topology', icon: 'diagram' },
    ],
    [
      { command: 'redis.transfer', label: 'Transfer', icon: 'transfer' },
      { command: 'redis.backup', label: 'Backup', icon: 'archive' },
      { command: 'redis.restore', label: 'Restore', icon: 'restore' },
      { command: 'redis.dumpAnalysis', label: 'Dump', icon: 'open' },
      TASKS,
    ],
  ],
  elasticsearch: [
    CONNECT,
    [
      { command: 'search.console', label: 'Console', icon: 'shell' },
      { command: 'search.documents', label: 'Documents', icon: 'table' },
      { command: 'search.sql', label: 'SQL', icon: 'query' },
    ],
    [
      { command: 'search.index', label: 'Index', icon: 'settings' },
      { command: 'search.createIndex', label: 'New Index', icon: 'table-new' },
    ],
    [
      { command: 'search.cluster', label: 'Cluster', icon: 'server' },
      { command: 'search.templates', label: 'Templates', icon: 'design' },
      { command: 'search.snapshots', label: 'Snapshots', icon: 'archive' },
    ],
  ],
};
