import type { QuerybaraError } from '@querybara/core';
import { describe, expect, it } from 'vitest';

import { mapMysqlError } from '../src/errors';
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
  if (sql.includes('information_schema.ROUTINES')) {
    return Promise.reject(
      serverError(
        1558,
        'Column count of mysql.proc is wrong. Expected 21, found 20. Created with MariaDB 50731, now running 100620. Please use mariadb-upgrade to fix this error',
      ),
    );
  }
  if (sql.includes('information_schema.EVENTS')) {
    return Promise.reject(serverError(1577, 'Cannot proceed, because event scheduler is disabled'));
  }
  return Promise.resolve([]);
};

const target = {
  database: 'app',
  mariadb: true,
  engine: 'mariadb',
  serverVersion: '10.6.20-MariaDB',
} as const;

describe('introspectMysql on a server with outdated system tables', () => {
  it('fails by default, so compare, sync and backup never miss routines', async () => {
    await expect(introspectMysql(outdatedServer, target, {})).rejects.toMatchObject({
      engineCode: 1558,
      hint: expect.stringMatching(/mariadb-upgrade/),
    });
  });

  it('leaves routines and events out of a best-effort snapshot', async () => {
    const snapshot = await introspectMysql(outdatedServer, target, { bestEffort: true });
    const [schema] = snapshot.schemas;
    expect(schema?.tables.map((t) => t.name)).toEqual(['users']);
    expect(schema?.routines).toEqual([]);
    expect(schema?.events).toEqual([]);
  });

  it('still fails a best-effort snapshot on other errors', async () => {
    const denied: QueryFn = (sql, values) =>
      sql.includes('information_schema.ROUTINES')
        ? Promise.reject(serverError(1142, 'SELECT command denied to user'))
        : outdatedServer(sql, values);
    await expect(introspectMysql(denied, target, { bestEffort: true })).rejects.toMatchObject({
      engineCode: 1142,
    });
  });
});
