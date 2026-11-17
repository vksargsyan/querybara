import type { QuerybaraError } from '@querybara/core';
import { describe, expect, it } from 'vitest';

import { mapMysqlError } from '../src/errors';
import { browseMysql } from '../src/browse';
import { introspectMysql, type QueryFn } from '../src/introspect';

/** A server error as the session's query function throws it (already mapped). */
function serverError(errno: number, message: string): QuerybaraError {
  return mapMysqlError(
    Object.assign(new Error(message), { errno, sqlState: 'HY000', sqlMessage: message }),
    { where: 'db.example.com:3306' },
  );
}

/**
 * A MySQL 5.7 data directory opened by MariaDB 10.6 without mariadb-upgrade: tables list, but
 * information_schema.ROUTINES fails on mysql.proc and EVENTS on the disabled event scheduler.
 */
const latin1 = (text: string): Uint8Array => Uint8Array.from(text, (c) => c.charCodeAt(0));

/** Rows as mysql.proc and mysql.event hold them (recorded from that server, trimmed). */
const PROC_ROWS = [
  {
    name: 'café',
    type: 'FUNCTION',
    definer: 'root@localhost',
    comment: "it's twice",
    created: '2026-11-17 13:01:54',
    modified: '2026-11-17 13:01:54',
    sql_mode: 'STRICT_TRANS_TABLES',
    params: latin1('x INT'),
    returns_raw: latin1('int(11)'),
    body: latin1("RETURN x * 2 -- 'é'"),
    sql_data_access: 'NO_SQL',
    is_deterministic: 'YES',
    security_type: 'DEFINER',
    charset: 'latin1',
  },
];
const EVENT_ROWS = [
  {
    name: 'mixed',
    definer: 'root@localhost',
    status: 'ENABLED',
    on_completion: 'DROP',
    comment: 'twice',
    sql_mode: '',
    body: latin1('DELETE FROM users WHERE id < -1'),
    charset: 'latin1',
    interval_raw: 30,
    unit: 'DAY_HOUR',
    execute_at: null,
    starts: '2026-11-17 13:01:54',
    ends: null,
    last_executed: null,
    zoned: 1,
  },
];

const OUTDATED_PROC = serverError(
  1558,
  'Column count of mysql.proc is wrong. Expected 21, found 20. Created with MariaDB 50731, now running 100620. Please use mariadb-upgrade to fix this error',
);

/**
 * A MySQL 5.7 data directory opened by MariaDB 10.6 without mariadb-upgrade: tables list, but
 * information_schema.ROUTINES fails on mysql.proc and EVENTS on the disabled event scheduler;
 * the mysql tables themselves still read.
 */
const outdatedServer: QueryFn = (sql) => {
  if (sql.includes('information_schema.SCHEMATA')) {
    return Promise.resolve([{ charset: 'utf8mb4', collation: 'utf8mb4_general_ci' }]);
  }
  if (sql.includes('information_schema.TABLES')) {
    return Promise.resolve([
      {
        name: 'users',
        type: 'BASE TABLE',
        engine: 'InnoDB',
        collation: 'utf8mb4_general_ci',
        charset: 'utf8mb4',
        auto_increment: null,
        create_options: '',
        comment: '',
      },
    ]);
  }
  if (sql.includes('information_schema.ROUTINES')) return Promise.reject(OUTDATED_PROC);
  if (sql.includes('information_schema.EVENTS')) {
    return Promise.reject(serverError(1577, 'Cannot proceed, because event scheduler is disabled'));
  }
  if (sql.includes('FROM mysql.proc')) return Promise.resolve(PROC_ROWS);
  if (sql.includes('FROM mysql.event')) return Promise.resolve(EVENT_ROWS);
  if (sql.startsWith('SHOW CREATE')) return Promise.reject(OUTDATED_PROC);
  return Promise.resolve([]);
};

/** The same server, to a user without SELECT on the mysql tables. */
const deniedSystemTables: QueryFn = (sql, values) =>
  sql.includes('FROM mysql.')
    ? Promise.reject(serverError(1142, 'SELECT command denied to user for table proc'))
    : outdatedServer(sql, values);

const target = {
  database: 'app',
  mariadb: true,
  engine: 'mariadb',
  serverVersion: '10.6.20-MariaDB',
} as const;

describe('introspectMysql on a server with outdated system tables', () => {
  it('reads routines and events from the mysql tables, definitions rebuilt', async () => {
    const [schema] = (await introspectMysql(outdatedServer, target, {})).schemas;
    expect(schema?.tables.map((t) => t.name)).toEqual(['users']);
    expect(schema?.routines).toEqual([
      {
        name: 'café',
        kind: 'function',
        signature: '',
        language: 'SQL',
        returns: 'int(11)',
        definer: 'root@localhost',
        comment: "it's twice",
        definition:
          "CREATE FUNCTION `café`(x INT) RETURNS int(11)\n    NO SQL\n    DETERMINISTIC\n    COMMENT 'it\\'s twice'\nRETURN x * 2 -- 'é'",
      },
    ]);
    expect(schema?.events).toEqual([
      {
        name: 'mixed',
        enabled: true,
        definition:
          "CREATE EVENT `mixed` ON SCHEDULE EVERY '1 6' DAY_HOUR STARTS '2026-11-17 13:01:54' ON COMPLETION NOT PRESERVE ENABLE COMMENT 'twice' DO DELETE FROM users WHERE id < -1",
      },
    ]);
  });

  it('fails without the mysql tables, so compare, sync and backup never miss routines', async () => {
    await expect(introspectMysql(deniedSystemTables, target, {})).rejects.toBe(OUTDATED_PROC);
    expect(OUTDATED_PROC.hint).toMatch(/mariadb-upgrade/);
  });

  it('leaves routines and events out of a best-effort snapshot without the mysql tables', async () => {
    const snapshot = await introspectMysql(deniedSystemTables, target, { bestEffort: true });
    const [schema] = snapshot.schemas;
    expect(schema?.tables.map((t) => t.name)).toEqual(['users']);
    expect(schema?.routines).toEqual([]);
    expect(schema?.events).toEqual([]);
  });

  it('still fails on other errors', async () => {
    const denied: QueryFn = (sql, values) =>
      sql.includes('information_schema.ROUTINES')
        ? Promise.reject(serverError(1142, 'SELECT command denied to user'))
        : outdatedServer(sql, values);
    await expect(introspectMysql(denied, target, { bestEffort: true })).rejects.toMatchObject({
      engineCode: 1142,
    });
  });
});

describe('browseMysql on a server with outdated system tables', () => {
  it('lists routines and events from the mysql tables', async () => {
    const functions = await browseMysql(outdatedServer, true, '10.6.20', ['app', 'functions']);
    expect(functions).toEqual([
      {
        kind: 'function',
        name: 'café',
        path: ['app', 'functions', 'café'],
        hasChildren: false,
        detail: {
          returns: 'int(11)',
          definer: 'root@localhost',
          created: '2026-11-17 13:01:54',
          modified: '2026-11-17 13:01:54',
          comment: "it's twice",
        },
      },
    ]);
    const events = await browseMysql(outdatedServer, true, '10.6.20', ['app', 'events']);
    expect(events.map((e) => [e.name, e.detail])).toEqual([
      ['mixed', { status: 'ENABLED', schedule: "EVERY '1 6' DAY_HOUR", comment: 'twice' }],
    ]);
  });

  it("shows the server's error when the mysql tables cannot be read either", async () => {
    await expect(
      browseMysql(deniedSystemTables, true, '10.6.20', ['app', 'procedures']),
    ).rejects.toBe(OUTDATED_PROC);
  });
});
