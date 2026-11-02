import type { Session } from '@querybara/core';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { launchApp, openNewConnection, type LaunchedApp } from './app';
import { connect, query, scratchDatabase } from './db';

/**
 * Navicat's table actions and object keys against a real PostgreSQL server: Empty Table, Truncate
 * Table and Duplicate Table (structure and data, structure only) from a table's menu, and ⌘O
 * (open data), ⌘D (design) and ⌘N (new table) on the focused tree row or Objects selection,
 * with the keys shown in the menu.
 */

const PG_URL = process.env['QUERYBARA_TEST_POSTGRES_URL'];
const NAME = 'E2E Table Actions';

test.skip(!PG_URL, 'Set QUERYBARA_TEST_POSTGRES_URL to run the end-to-end tests');

test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp;
let page: Page;
let database: Awaited<ReturnType<typeof scratchDatabase>> | undefined;
let direct: Session | undefined;

test.beforeAll(async () => {
  database = await scratchDatabase(PG_URL!);
  direct = await connect(PG_URL!, database.name);
  await query(
    direct,
    `CREATE TABLE items (
       id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
       name text NOT NULL,
       price numeric NOT NULL DEFAULT 1,
       doubled numeric GENERATED ALWAYS AS (price * 2) STORED
     )`,
  );
  await query(
    direct,
    `INSERT INTO items (name, price) SELECT 'item ' || g, g FROM generate_series(1, 25) g`,
  );
  await query(direct, `CREATE TABLE notes (id serial PRIMARY KEY, body text)`);
  await query(direct, `INSERT INTO notes (body) SELECT 'n' || g FROM generate_series(1, 5) g`);
  launched = await launchApp();
  page = launched.page;
});

test.afterAll(async () => {
  await launched?.close();
  await direct?.close();
  await database?.drop();
});

function treeRow(text: string): Locator {
  return page.locator('[data-tree-row]').filter({ has: page.getByText(text, { exact: true }) });
}

async function count(table: string): Promise<number> {
  const rows = await query(direct!, `SELECT count(*)::int FROM ${table}`);
  return Number(rows[0]?.[0]);
}

async function nextId(table: string, values: string): Promise<number> {
  const rows = await query(direct!, `INSERT INTO ${table} ${values} RETURNING id`);
  return Number(rows[0]?.[0]);
}

async function tableMenu(name: string): Promise<Locator> {
  await treeRow(name).click({ button: 'right' });
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  return menu;
}

const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const label = (key: string) => (process.platform === 'darwin' ? `⌘${key}` : `Ctrl+${key}`);

test('a table’s menu offers empty, truncate and duplicate, with the object keys shown', async () => {
  await openNewConnection(page);
  const dialog = page.getByRole('dialog', { name: 'New connection' });
  await dialog.getByLabel('Paste a URI to fill the form').fill(database!.url);
  await dialog.getByRole('button', { name: 'Fill from URI' }).click();
  await dialog.getByLabel('Name').fill(NAME);
  await dialog.getByLabel('Password storage').selectOption('session');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  const profile = page.getByRole('treeitem', { name: NAME });
  await profile.locator('[data-tree-row]').first().dblclick();
  await expect(profile.getByText('Connected', { exact: true })).toBeAttached();
  await treeRow(database!.name).click();
  await treeRow('public').click();
  await treeRow('Tables').click();
  await expect(treeRow('items')).toBeVisible();

  const menu = await tableMenu('items');
  const item = (name: string) => menu.getByRole('menuitem', { name, exact: true });
  await expect(item('Open data')).toContainText(label('O'));
  await expect(item('Open data')).toHaveAttribute('aria-keyshortcuts', label('O'));
  await expect(item('Design table')).toContainText(label('D'));
  await expect(item('New table…')).toContainText(label('N'));
  await expect(item('Empty table…')).toBeVisible();
  await expect(item('Truncate table…')).toBeVisible();
  await expect(item('Duplicate table')).toBeVisible();
  if (process.env['QUERYBARA_E2E_SHOTS']) {
    await item('Duplicate table').hover();
    await expect(page.getByRole('menuitem', { name: 'Structure only…' })).toBeVisible();
    await page.screenshot({ path: `${process.env['QUERYBARA_E2E_SHOTS']}/table-menu.png` });
  }
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  // A schema's menu shows ⌘N on New table… too.
  const schema = await tableMenu('public');
  await expect(schema.getByRole('menuitem', { name: 'New table…', exact: true })).toContainText(
    label('N'),
  );
  await page.keyboard.press('Escape');
});

test('duplicates a table with its rows, keeping identity values and moving its sequence', async () => {
  const menu = await tableMenu('items');
  await menu.getByRole('menuitem', { name: 'Duplicate table', exact: true }).hover();
  await page.getByRole('menuitem', { name: 'Structure and data…', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: 'Duplicate table items' });
  await expect(dialog.getByTestId('duplicate-table-name')).toHaveValue('items_copy');
  const script = dialog.getByTestId('duplicate-table-script');
  await expect(script).toContainText(
    'CREATE TABLE "public"."items_copy" (LIKE "public"."items" INCLUDING ALL);',
  );
  await expect(script).toContainText(
    'INSERT INTO "public"."items_copy" ("id", "name", "price") OVERRIDING SYSTEM VALUE',
  );
  // A name in use is refused before anything runs.
  await dialog.getByTestId('duplicate-table-name').fill('notes');
  await expect(dialog.getByText('A table or view named notes already exists')).toBeVisible();
  await expect(dialog.getByTestId('duplicate-table-run')).toBeDisabled();
  await dialog.getByTestId('duplicate-table-name').fill('items_copy');
  await dialog.getByTestId('duplicate-table-run').click();
  await expect(dialog).toBeHidden();

  await expect(treeRow('items_copy')).toBeVisible();
  expect(await count('items_copy')).toBe(25);
  // The copy's own identity carries on after the copied values.
  expect(await nextId('items_copy', `(name) VALUES ('new')`)).toBe(26);
  const doubled = await query(direct!, `SELECT doubled::int FROM items_copy WHERE id = 3`);
  expect(Number(doubled[0]?.[0])).toBe(6);
});

test('duplicates the structure alone, under the next free name', async () => {
  const menu = await tableMenu('items');
  await menu.getByRole('menuitem', { name: 'Duplicate table', exact: true }).hover();
  await page.getByRole('menuitem', { name: 'Structure only…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Duplicate table items' });
  await expect(dialog.getByTestId('duplicate-table-name')).toHaveValue('items_copy_2');
  await expect(dialog.getByTestId('duplicate-table-script')).not.toContainText('INSERT');
  await dialog.getByTestId('duplicate-table-run').click();
  await expect(dialog).toBeHidden();
  await expect(treeRow('items_copy_2')).toBeVisible();
  expect(await count('items_copy_2')).toBe(0);
});

test('empties a table after showing the statement; its counter keeps going', async () => {
  const menu = await tableMenu('items_copy');
  await menu.getByRole('menuitem', { name: 'Empty table…', exact: true }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Empty table items_copy?' });
  await expect(confirm.getByTestId('confirm-detail')).toHaveText(
    'DELETE FROM "public"."items_copy";',
  );
  await confirm.getByRole('button', { name: 'Empty' }).click();
  await expect(confirm).toBeHidden();
  await expect.poll(() => count('items_copy')).toBe(0);
  expect(await nextId('items_copy', `(name) VALUES ('after')`)).toBe(27);
});

test('truncates a table after showing the statement; its counter starts over', async () => {
  // An open data view of the table reloads.
  await treeRow('notes').click();
  const data = page.getByTestId('table-data-panel').filter({ visible: true });
  await expect(data.getByTestId('table-row-count')).toHaveText('5 rows loaded');

  const menu = await tableMenu('notes');
  await menu.getByRole('menuitem', { name: 'Truncate table…', exact: true }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Truncate table notes?' });
  await expect(confirm.getByTestId('confirm-detail')).toHaveText(
    'TRUNCATE TABLE "public"."notes" RESTART IDENTITY;',
  );
  await confirm.getByRole('button', { name: 'Truncate' }).click();
  await expect(confirm).toBeHidden();
  await expect.poll(() => count('notes')).toBe(0);
  await expect(data.getByTestId('table-row-count')).toHaveText('0 rows loaded');
  expect(await nextId('notes', `(body) VALUES ('first again')`)).toBe(1);
});

test('⌘D designs, ⌘O opens and ⌘N starts a new table from the focused tree row', async () => {
  await treeRow('items').focus();
  await page.keyboard.press(`${mod}+d`);
  const designer = page.getByTestId('table-designer').filter({ visible: true });
  await expect(designer.getByLabel('Table name')).toHaveValue('items');

  await treeRow('items').focus();
  await page.keyboard.press(`${mod}+o`);
  const data = page.getByTestId('table-data-panel').filter({ visible: true });
  await expect(data.getByTestId('table-row-count')).toHaveText('25 rows loaded');

  // On the schema (where PostgreSQL's tables live), ⌘N opens a new table's designer.
  await treeRow('public').focus();
  await page.keyboard.press(`${mod}+n`);
  await expect(designer.getByLabel('Table name')).toHaveValue('new_table');

  // Away from the explorer the keys do nothing of the sort.
  await designer.getByLabel('Table name').focus();
  await page.keyboard.press(`${mod}+o`);
  await expect(designer.getByLabel('Table name')).toHaveValue('new_table');
});

test('the Objects view’s keys act on its selection, and from its menu', async () => {
  await page.getByRole('tab', { name: /Objects/ }).click();
  const grid = page.getByRole('grid', { name: 'Objects' });
  const row = (name: string) =>
    grid.getByRole('row').filter({ has: page.getByText(name, { exact: true }) });
  await row('items_copy_2').click();
  await page.keyboard.press(`${mod}+d`);
  const designer = page.getByTestId('table-designer').filter({ visible: true });
  await expect(designer.getByLabel('Table name')).toHaveValue('items_copy_2');

  await page.getByRole('tab', { name: /Objects/ }).click();
  await row('items_copy').click({ button: 'right' });
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'Open data', exact: true })).toContainText(
    label('O'),
  );
  // The key works with the menu open, and closes it.
  await page.keyboard.press(`${mod}+o`);
  await expect(menu).toBeHidden();
  const data = page.getByTestId('table-data-panel').filter({ visible: true });
  await expect(data.getByTestId('table-row-count')).toHaveText('1 row loaded');
});
