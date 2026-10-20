import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import type { Session } from '@querybara/core';
import { createMysqlAdapter } from '@querybara/driver-mysql';
import { resolvedProfileFromUrl } from '@querybara/driver-sql-base';
import { expect, test, type Page } from '@playwright/test';

import { launchApp, openNewConnection, type LaunchedApp } from './app';
import { connect, query } from './db';

/**
 * "New database…" in a SQL connection's menu against a real PostgreSQL server: the statement
 * shown as the form changes, an encoding moving the template to template0, a name that exists
 * refused, and the new database created and listed in the side bar; and, when a MySQL server
 * is configured, a character set and collation there. Screenshots go to QUERYBARA_E2E_SHOTS
 * when it is set.
 */

const PG_URL = process.env['QUERYBARA_TEST_POSTGRES_URL'];
const MYSQL_URL = process.env['QUERYBARA_TEST_MYSQL_URL'];
const SHOTS = process.env['QUERYBARA_E2E_SHOTS'];
const NAME = 'E2E New database';

test.skip(!PG_URL, 'Set QUERYBARA_TEST_POSTGRES_URL to run the end-to-end tests');

test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp | undefined;
let page: Page;
let admin: Session | undefined;
let mysqlAdmin: Session | undefined;
const created = `querybara_e2e_${randomBytes(4).toString('hex')}`;

test.beforeAll(async () => {
  admin = await connect(PG_URL!);
  if (MYSQL_URL) mysqlAdmin = await createMysqlAdapter().connect(resolvedProfileFromUrl(MYSQL_URL));
  launched = await launchApp();
  page = launched.page;
});

test.afterAll(async () => {
  await launched?.close();
  if (admin) {
    await query(admin, `DROP DATABASE IF EXISTS "${created}" WITH (FORCE)`).catch(() => undefined);
    await admin.close();
  }
  if (mysqlAdmin) {
    await query(mysqlAdmin, `DROP DATABASE IF EXISTS \`${created}\``).catch(() => undefined);
    await mysqlAdmin.close();
  }
});

/** Saves a connection from its URL, connects and picks "New database…" in its menu. */
async function openNewDatabase(url: string, name: string): Promise<void> {
  await openNewConnection(page);
  const connection = page.getByRole('dialog', { name: 'New connection' });
  await connection.getByLabel('Paste a URI to fill the form').fill(url);
  await connection.getByRole('button', { name: 'Fill from URI' }).click();
  await expect(connection.getByText('Filled from the URI')).toBeVisible();
  await connection.getByLabel('Name', { exact: true }).fill(name);
  await connection.getByLabel('Password storage').selectOption('session');
  await connection.getByRole('button', { name: 'Save' }).click();
  await expect(connection).toBeHidden();

  const profile = page.getByRole('treeitem', { name });
  await profile.locator('[data-tree-row]').first().dblclick();
  await expect(profile.getByText('Connected', { exact: true })).toBeAttached();
  await profile.locator('[data-tree-row]').first().hover();
  await profile.getByRole('button', { name: 'Actions' }).first().click();
  await page.getByRole('menuitem', { name: 'New database…' }).click();
}

test('creates a database from the connection menu', async () => {
  await openNewDatabase(PG_URL!, NAME);
  const profile = page.getByRole('treeitem', { name: NAME });

  const dialog = page.getByTestId('new-database-dialog');
  const statement = page.getByTestId('new-database-statement');
  const create = page.getByTestId('new-database-create');
  await expect(dialog).toBeVisible();
  await expect(create).toBeDisabled();

  // A database the server has already.
  await page.getByTestId('new-database-name').fill('postgres');
  await expect(dialog.getByRole('alert')).toHaveText('The database postgres exists already');
  await expect(create).toBeDisabled();

  await page.getByTestId('new-database-name').fill(created);
  await expect(statement).toHaveText(`CREATE DATABASE "${created}"`);
  await page.getByTestId('new-database-encoding').selectOption('UTF8');
  await expect(page.getByTestId('new-database-template')).toHaveValue('template0');
  await expect(statement).toHaveText(
    `CREATE DATABASE "${created}" TEMPLATE "template0" ENCODING 'UTF8'`,
  );
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'new-database-postgres.png') });
  await create.click();
  await expect(dialog).toBeHidden();

  const rows = await query(admin!, `SELECT datname FROM pg_database WHERE datname = '${created}'`);
  expect(rows).toEqual([[created]]);
  await expect(profile.getByRole('treeitem', { name: created })).toBeVisible();
});

test('creates a MySQL database with a character set and collation', async () => {
  test.skip(!MYSQL_URL, 'Set QUERYBARA_TEST_MYSQL_URL to run against MySQL');
  const name = 'E2E New MySQL database';
  await openNewDatabase(MYSQL_URL!, name);
  const profile = page.getByRole('treeitem', { name });

  const dialog = page.getByTestId('new-database-dialog');
  const statement = page.getByTestId('new-database-statement');
  await page.getByTestId('new-database-name').fill(created);
  await expect(statement).toHaveText(`CREATE DATABASE \`${created}\``);
  await page.getByTestId('new-database-charset').selectOption('latin1');
  // The collations offered are the character set's.
  await expect(
    page.getByTestId('new-database-collation').locator('option[value="utf8mb4_bin"]'),
  ).toHaveCount(0);
  await page.getByTestId('new-database-collation').selectOption('latin1_bin');
  await expect(statement).toHaveText(
    `CREATE DATABASE \`${created}\` CHARACTER SET latin1 COLLATE latin1_bin`,
  );
  if (SHOTS) await page.screenshot({ path: join(SHOTS, 'new-database-mysql.png') });
  await page.getByTestId('new-database-create').click();
  await expect(dialog).toBeHidden();

  const rows = await query(
    mysqlAdmin!,
    `SELECT DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '${created}'`,
  );
  expect(rows).toEqual([['latin1', 'latin1_bin']]);
  await expect(profile.getByRole('treeitem', { name: created })).toBeVisible();
});
