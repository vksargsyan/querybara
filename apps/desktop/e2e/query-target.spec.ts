import { join } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { launchApp, openNewConnection, type LaunchedApp } from './app';
import { connect, query, scratchDatabase } from './db';

/**
 * The connection and database selectors at the start of a SQL tab's and a query builder's
 * toolbar, against PostgreSQL: two scratch databases with a table each and a connection to
 * each; a SQL tab moved to the other database and then to the other connection, each run
 * landing where the selectors say; a query builder moved to the other database, its table list
 * following. Screenshots go to QUERYBARA_E2E_SHOTS when it is set.
 */

const PG_URL = process.env['QUERYBARA_TEST_POSTGRES_URL'];
const SHOTS = process.env['QUERYBARA_E2E_SHOTS'];
const FIRST = 'E2E Target A';
const SECOND = 'E2E Target B';

test.skip(!PG_URL, 'Set QUERYBARA_TEST_POSTGRES_URL to run the end-to-end tests');

test.describe.configure({ mode: 'serial' });

type Scratch = Awaited<ReturnType<typeof scratchDatabase>>;

let launched: LaunchedApp | undefined;
let page: Page;
let first: Scratch | undefined;
let second: Scratch | undefined;

test.beforeAll(async () => {
  first = await scratchDatabase(PG_URL!);
  second = await scratchDatabase(PG_URL!);
  for (const [database, table] of [
    [first, 'alpha_items'],
    [second, 'beta_items'],
  ] as const) {
    const direct = await connect(PG_URL!, database.name);
    try {
      await query(direct, `CREATE TABLE ${table} (id integer PRIMARY KEY)`);
    } finally {
      await direct.close();
    }
  }
  launched = await launchApp();
  page = launched.page;
});

test.afterAll(async () => {
  await launched?.close();
  await first?.drop();
  await second?.drop();
});

async function shot(name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function addConnection(name: string, url: string): Promise<void> {
  await openNewConnection(page);
  const dialog = page.getByRole('dialog', { name: 'New connection' });
  await dialog.getByLabel('Paste a URI to fill the form').fill(url);
  await dialog.getByRole('button', { name: 'Fill from URI' }).click();
  await expect(dialog.getByText('Filled from the URI')).toBeVisible();
  await dialog.getByLabel('Name', { exact: true }).fill(name);
  await dialog.getByLabel('Password storage').selectOption('session');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
}

function chosen(select: Locator): Locator {
  return select.locator('option:checked');
}

test('a SQL tab moves to another database and connection from its toolbar', async () => {
  await addConnection(FIRST, first!.url);
  await addConnection(SECOND, second!.url);
  const profile = page.getByRole('treeitem', { name: FIRST });
  await profile.locator('[data-tree-row]').first().dblclick();
  await expect(profile.getByText('Connected', { exact: true })).toBeAttached();
  await page.getByRole('button', { name: 'New query' }).click();

  const panel = page.getByTestId('query-panel').filter({ visible: true });
  const connection = panel.getByLabel('Connection', { exact: true });
  const database = panel.getByLabel('Database', { exact: true });
  await expect(chosen(connection)).toHaveText(FIRST);
  await expect(chosen(database)).toHaveText(first!.name);

  const run = async (): Promise<void> => {
    await panel.getByTestId('sql-editor').click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Delete');
    await page.keyboard.type('select current_database() as db');
    await page.keyboard.press('ControlOrMeta+Enter');
  };
  const result = panel.getByTestId('glide-cell-1-0');

  await run();
  await expect(result).toHaveText(first!.name);

  // The other database on the same connection: the next run opens a session there.
  await database.selectOption(second!.name);
  await expect(chosen(database)).toHaveText(second!.name);
  await panel.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(result).toHaveText(second!.name);
  await shot('query-target');

  // Another connection starts on its own database, and the tab's default title follows.
  await connection.selectOption({ label: SECOND });
  await expect(chosen(connection)).toHaveText(SECOND);
  await panel.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(result).toHaveText(second!.name);
  await expect(chosen(database)).toHaveText(second!.name);
  await expect(page.getByTestId('window-title')).toHaveText(`${SECOND} query`);
});

test('a query builder moves to another database from its toolbar', async () => {
  const row = page
    .locator('[data-tree-row]')
    .filter({ has: page.getByText(first!.name, { exact: true }) });
  const profile = page.getByRole('treeitem', { name: FIRST });
  await profile.locator('[data-tree-row]').first().click();
  await expect(row).toBeVisible();
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New query builder' }).click();

  const view = page.getByTestId('query-builder').filter({ visible: true });
  await expect(view.getByRole('button', { name: 'Add alpha_items' })).toBeVisible();
  const database = view.getByLabel('Database', { exact: true });
  await expect(chosen(view.getByLabel('Connection', { exact: true }))).toHaveText(FIRST);
  await expect(chosen(database)).toHaveText(first!.name);

  await database.selectOption(second!.name);
  await expect(view.getByRole('button', { name: 'Add beta_items' })).toBeVisible();
  await expect(view.getByRole('button', { name: 'Add alpha_items' })).toBeHidden();
  await expect(page.getByTestId('window-title')).toHaveText(`Query builder (${second!.name})`);
  await shot('query-target-builder');
});
