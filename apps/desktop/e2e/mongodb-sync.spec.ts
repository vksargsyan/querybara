import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { MongoSession } from '@querybara/driver-mongodb';
import { runMongoCommand } from '@querybara/sync';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { launchApp, openNewConnection, type LaunchedApp } from './app';
import { connectMongo, scratchMongoDatabase, withoutTls } from './mongo-db';

/**
 * MongoDB structure and data compare in the app against the test replica set (spec §13): two
 * databases are compared from the explorer's database menu, the destructive drop is left
 * unticked, the mongosh script applied and the re-compare shows only the drop; then a data
 * compare finds a document to insert, one to update (only the changed field shown) and one to
 * delete, applies them after the confirmation and compares clean. With QUERYBARA_E2E_SHOTS set,
 * screenshots of both panels are saved there.
 */

const MONGO_URL = process.env['QUERYBARA_TEST_MONGODB_URL'];
const SHOTS = process.env['QUERYBARA_E2E_SHOTS'];
const NAME = 'E2E Mongo Sync';

test.skip(!MONGO_URL, 'Set QUERYBARA_TEST_MONGODB_URL to run the MongoDB end-to-end tests');

test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp | undefined;
let page: Page;
let direct: MongoSession | undefined;
let source: ReturnType<typeof scratchMongoDatabase> | undefined;
let target: ReturnType<typeof scratchMongoDatabase> | undefined;

async function run(database: string, commands: string[]): Promise<void> {
  await direct!.useDatabase(database);
  for (const command of commands) await runMongoCommand(direct!, command);
}

test.beforeAll(async () => {
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
  direct = await connectMongo(MONGO_URL!);
  source = scratchMongoDatabase(direct);
  target = scratchMongoDatabase(direct);
  await run(source.name, [
    `{ create: 'customers', validator: { $jsonSchema: { required: ['email'] } } }`,
    `{ createIndexes: 'customers', indexes: [{ key: { email: 1 }, name: 'email_1', unique: true }] }`,
    `{ create: 'orders' }`,
    `{ insert: 'customers', documents: [
        { _id: 1, email: 'ann@example.com', plan: 'pro' },
        { _id: 2, email: 'bob@example.com', plan: 'free', seats: NumberLong(5) },
        { _id: 3, email: 'cy@example.com' }
      ] }`,
  ]);
  await run(target.name, [
    `{ create: 'customers' }`,
    `{ create: 'archive' }`,
    `{ insert: 'customers', documents: [
        { _id: 2, email: 'bob@example.com', plan: 'free', seats: 3 },
        { _id: 3, email: 'cy@example.com' },
        { _id: 4, email: 'old@example.com' }
      ] }`,
  ]);
  launched = await launchApp();
  page = launched.page;
});

test.afterAll(async () => {
  await launched?.close();
  await source?.drop().catch(() => undefined);
  await target?.drop().catch(() => undefined);
  await direct?.close();
});

async function shot(name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

function treeRow(text: string): Locator {
  return page.locator('[data-tree-row]').filter({ has: page.getByText(text, { exact: true }) });
}

function panel(testId: string): Locator {
  return page.getByTestId(testId).filter({ visible: true });
}

async function contextMenu(row: Locator, item: string): Promise<void> {
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: item }).click();
}

async function chooseTarget(view: Locator): Promise<void> {
  await view.getByLabel('Target connection').selectOption({ label: `${NAME} · MongoDB` });
  await view.getByLabel('Target database').fill(target!.name);
}

test('connects and lists both databases', async () => {
  await openNewConnection(page);
  const dialog = page.getByRole('dialog', { name: 'New connection' });
  await dialog.getByLabel('Paste a URI to fill the form').fill(withoutTls(MONGO_URL!));
  await dialog.getByRole('button', { name: 'Fill from URI' }).click();
  await expect(dialog.getByText('Filled from the URI')).toBeVisible();
  await dialog.getByLabel('Name').fill(NAME);
  await dialog.getByLabel('Password storage').selectOption('session');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  const profile = page.getByRole('treeitem', { name: NAME });
  await profile.locator('[data-tree-row]').first().dblclick();
  await expect(treeRow(source!.name)).toBeVisible();
  await expect(treeRow(target!.name)).toBeVisible();
});

test('compares the structure, applies the commands and re-compares to the unticked drop', async () => {
  await contextMenu(treeRow(source!.name), 'Compare structure with…');
  const view = panel('structure-compare');
  await expect(view.getByLabel('Source database')).toHaveValue(source!.name);
  await chooseTarget(view);
  // Only the options MongoDB honours, and no rename rules.
  await expect(view.getByText('Ignore index names')).toBeVisible();
  await expect(view.getByText('Ignore DEFINER')).toHaveCount(0);
  await view.getByRole('button', { name: 'Compare', exact: true }).click();

  await expect(view.getByTestId('sync-summary')).toContainText('4 differences');
  const drop = view.getByRole('checkbox', { name: 'Apply drop collection archive' });
  await expect(drop).not.toBeChecked();
  await expect(
    view.getByRole('checkbox', { name: 'Apply create collection orders' }),
  ).toBeChecked();
  await expect(
    view.getByRole('checkbox', { name: 'Apply alter collection customers' }),
  ).toBeChecked();
  await view.getByRole('button', { name: 'customers.email_1' }).click();
  await expect(view.getByTestId('source-ddl')).toContainText(
    "db.customers.createIndex({ email: 1 }, { name: 'email_1', unique: true })",
  );
  await view.getByRole('tab', { name: 'Script' }).click();
  await expect(view.getByTestId('sync-script')).toContainText(
    "db.runCommand({ create: 'orders' });",
  );
  await shot('mongodb-structure-compare');

  await view.getByRole('button', { name: 'Apply…' }).click();
  const review = page.getByRole('alertdialog', { name: 'Review and apply' });
  await expect(review.getByTestId('non-transactional')).toContainText(
    'MongoDB runs these commands',
  );
  // The commands are not transactional, so the review asks for an explicit tick.
  await review.getByRole('checkbox', { name: 'I reviewed this script and want to run it' }).check();
  await review.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(view.getByTestId('sync-notice')).toContainText(
    'Compared again: 1 difference remains, none of them applied.',
  );
  await expect(view.getByTestId('sync-operation')).toHaveAttribute(
    'data-operation-id',
    'collection:archive:drop',
  );
});

test('compares documents, applies an insert, an update and a delete, and compares clean', async () => {
  await contextMenu(treeRow(source!.name), 'Compare data with…');
  const view = panel('data-compare');
  await chooseTarget(view);
  await expect(view.getByText('Ignore field order')).toBeVisible();
  await expect(view.getByText('Float tolerance')).toHaveCount(0);
  await view.getByRole('button', { name: 'Compare data', exact: true }).click();

  const customers = view.getByTestId('data-table-row').filter({ hasText: 'customers' });
  await expect(customers.locator('td').nth(3)).toHaveText('1');
  await expect(customers.locator('td').nth(4)).toHaveText('1');
  await expect(customers.locator('td').nth(5)).toHaveText('1');
  await expect(customers.locator('td').nth(6)).toHaveText('1');
  await customers.getByRole('button', { name: 'customers' }).click();
  const grid = view.getByTestId('data-row-grid');
  await expect(grid).toContainText("{ _id: 1, email: 'ann@example.com', plan: 'pro' }");
  await view.getByRole('tab', { name: 'Updates (1)' }).click();
  const changed = grid.locator('td[data-changed]');
  await expect(changed).toHaveCount(1);
  await expect(changed).toContainText("{ seats: Long('5') }");
  await expect(changed).toContainText('{ seats: 3 }');
  await shot('mongodb-data-compare');

  // The delete unticked in the row grid stays: the insert and the update are applied.
  await view.getByRole('tab', { name: 'Deletes (1)' }).click();
  await grid.getByRole('checkbox', { name: 'Sync 4', exact: true }).uncheck();
  await expect(view.getByRole('tab', { name: 'Deletes (0 of 1)' })).toBeVisible();
  await expect(grid.locator('tr[data-ticked="false"]')).toHaveCount(1);
  await expect(view.getByText('2 changes in 1 collection')).toBeVisible();
  await shot('mongodb-data-compare-row-ticks');
  await view.getByRole('button', { name: 'Apply…' }).click();
  const review = page.getByRole('alertdialog', { name: 'Review and apply the data changes' });
  const script = review.getByTestId('data-apply-script');
  await expect(script).toContainText("db.runCommand({ insert: 'customers'");
  await expect(script).not.toContainText("delete: 'customers'");
  await review.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(view.getByTestId('sync-notice')).toContainText(
    'Applied 2 document changes to 1 collection. Compared again: 1 difference remains, the unticked rows among them.',
  );

  await view.getByRole('button', { name: 'Apply…' }).click();
  await expect(script).toContainText("db.runCommand({ delete: 'customers'");
  await review
    .getByRole('checkbox', { name: 'I want to delete 1 document from the target' })
    .check();
  await review.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(view.getByTestId('sync-notice')).toContainText(
    'Applied 1 document change to 1 collection. Compared again: no differences remain in the synced collections.',
  );
});
