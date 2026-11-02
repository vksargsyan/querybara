import { tableDefSchema } from '@querybara/core';
import { describe, expect, it } from 'vitest';

import {
  copyNameIssue,
  duplicateTableScript,
  emptyTableSql,
  scriptText,
  truncateTableSql,
} from '../src/renderer/src/state/table-actions';

/**
 * The explorer's Empty Table, Truncate Table and Duplicate Table (Navicat's): the exact SQL each
 * shows and runs, per dialect, and the names a copy may take.
 */

const mysqlOrders = { database: 'shop', schema: 'shop', name: 'orders' };
const pgOrders = { database: 'shop', schema: 'sales', name: 'orders' };

const live = tableDefSchema.parse({
  name: 'orders',
  columns: [
    { name: 'total', ordinal: 2, dataType: 'numeric(10,2)', nullable: false },
    {
      name: 'id',
      ordinal: 1,
      dataType: 'bigint',
      nullable: false,
      identity: { generation: 'always' },
    },
    {
      name: 'total_with_tax',
      ordinal: 3,
      dataType: 'numeric(10,2)',
      nullable: true,
      generated: { expression: 'total * 1.2', stored: true },
    },
    { name: 'Note', ordinal: 4, dataType: 'text', nullable: true },
  ],
});

describe('empty and truncate', () => {
  it('deletes every row, keeping the counter', () => {
    expect(emptyTableSql(mysqlOrders, 'mysql')).toBe('DELETE FROM `shop`.`orders`');
    expect(emptyTableSql(pgOrders, 'postgres')).toBe('DELETE FROM "sales"."orders"');
  });

  it('truncates and starts the counter over (PostgreSQL restarts its sequences)', () => {
    expect(truncateTableSql(mysqlOrders, 'mariadb')).toBe('TRUNCATE TABLE `shop`.`orders`');
    expect(truncateTableSql(pgOrders, 'postgres')).toBe(
      'TRUNCATE TABLE "sales"."orders" RESTART IDENTITY',
    );
  });

  it('quotes names that need it', () => {
    expect(emptyTableSql({ database: 'a', schema: 'a', name: 'we`ird' }, 'mysql')).toBe(
      'DELETE FROM `a`.`we``ird`',
    );
    expect(truncateTableSql({ database: 'a', schema: 'my "s"', name: 'T' }, 'postgres')).toBe(
      'TRUNCATE TABLE "my ""s"""."T" RESTART IDENTITY',
    );
  });
});

describe('duplicate', () => {
  it('copies the structure alone with CREATE TABLE ... LIKE', () => {
    expect(duplicateTableScript(mysqlOrders, 'orders_copy', 'mysql', 'structure')).toEqual({
      statements: ['CREATE TABLE `shop`.`orders_copy` LIKE `shop`.`orders`'],
      transactional: false,
    });
    expect(duplicateTableScript(pgOrders, 'orders_copy', 'postgres', 'structure')).toEqual({
      statements: [
        'BEGIN',
        'CREATE TABLE "sales"."orders_copy" (LIKE "sales"."orders" INCLUDING ALL)',
        'COMMIT',
      ],
      transactional: true,
    });
  });

  it('copies the rows of every column the server does not compute, in column order', () => {
    const { statements } = duplicateTableScript(
      mysqlOrders,
      'orders_copy',
      'mysql',
      'structure-and-data',
      live,
    );
    expect(statements[1]).toBe(
      'INSERT INTO `shop`.`orders_copy` (`id`, `total`, `Note`) SELECT `id`, `total`, `Note` FROM `shop`.`orders`',
    );
  });

  it('keeps PostgreSQL identity values and moves the copy’s sequences past them', () => {
    expect(
      duplicateTableScript(pgOrders, 'orders_copy', 'postgres', 'structure-and-data', live),
    ).toEqual({
      statements: [
        'BEGIN',
        'CREATE TABLE "sales"."orders_copy" (LIKE "sales"."orders" INCLUDING ALL)',
        'INSERT INTO "sales"."orders_copy" ("id", "total", "Note") OVERRIDING SYSTEM VALUE SELECT "id", "total", "Note" FROM "sales"."orders"',
        `SELECT setval(pg_get_serial_sequence('"sales"."orders_copy"', 'id'), MAX("id")) FROM "sales"."orders_copy" HAVING MAX("id") IS NOT NULL`,
        'COMMIT',
      ],
      transactional: true,
    });
  });

  it('copies every column when the definition is not known', () => {
    const { statements } = duplicateTableScript(mysqlOrders, 'c', 'mysql', 'structure-and-data');
    expect(statements[1]).toBe('INSERT INTO `shop`.`c` SELECT * FROM `shop`.`orders`');
  });

  it('shows the script with its terminators', () => {
    const script = duplicateTableScript(pgOrders, 'c', 'postgres', 'structure');
    expect(scriptText(script, 'postgres')).toBe(
      'BEGIN;\nCREATE TABLE "sales"."c" (LIKE "sales"."orders" INCLUDING ALL);\nCOMMIT;',
    );
  });
});

describe('the copy’s name', () => {
  it('must be new in the schema, and within the engine’s length', () => {
    expect(copyNameIssue('orders_copy', 'mysql', ['orders'])).toBeUndefined();
    expect(copyNameIssue('', 'mysql', [])).toBe('Name the copy');
    expect(copyNameIssue(' x', 'mysql', [])).toBe('The name starts or ends with a space');
    expect(copyNameIssue('Orders', 'mysql', ['orders'])).toBe(
      'A table or view named Orders already exists',
    );
    // PostgreSQL keeps the case of quoted names.
    expect(copyNameIssue('Orders', 'postgres', ['orders'])).toBeUndefined();
    expect(copyNameIssue('x'.repeat(64), 'mysql', [])).toBeUndefined();
    expect(copyNameIssue('x'.repeat(65), 'mysql', [])).toBe(
      'The name is longer than 64 characters',
    );
    expect(copyNameIssue('é'.repeat(32), 'postgres', [])).toBe('The name is longer than 63 bytes');
  });
});
