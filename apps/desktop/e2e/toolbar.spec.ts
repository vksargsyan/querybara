import type { Session } from '@querybara/core';
import { expect, test, type Locator, type Page } from '@playwright/test';

import { launchApp, openNewConnection, type LaunchedApp } from './app';
import { connect, query, scratchDatabase } from './db';

/**
 * The connection toolbar (ADR 0042) against real servers: it shows the tools of the connection
 * in front and follows it from a PostgreSQL tab to a Redis one and back; its SQL tools act on
 * the database, schema and table in front and ask for the rest; Redis and Elasticsearch get
 * their own sets. Each engine's part runs when its server's URL is set.
 */

const PG_URL = process.env['QUERYBARA_TEST_POSTGRES_URL'];
const REDIS_URL = process.env['QUERYBARA_TEST_REDIS_URL'];
const ES_URL = process.env['QUERYBARA_TEST_ELASTICSEARCH_URL'];
const PG_NAME = 'E2E Toolbar PostgreSQL';
const REDIS_NAME = 'E2E Toolbar Redis';
const ES_NAME = 'E2E Toolbar Elasticsearch';

test.skip(!PG_URL && !REDIS_URL && !ES_URL, 'Set a database URL to run the toolbar tests');

test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp | undefined;
let page: Page;
let database: Awaited<ReturnType<typeof scratchDatabase>> | undefined;
let direct: Session | undefined;

test.beforeAll(async () => {
  if (PG_URL) {
    database = await scratchDatabase(PG_URL);
    direct = await connect(PG_URL, database.name);
    await query(direct, 'CREATE TABLE tb_orders (id integer PRIMARY KEY, total numeric)');
    await query(direct, 'INSERT INTO tb_orders VALUES (1, 10), (2, 20)');
  }
  launched = await launchApp();
  page = launched.page;
});

test.afterAll(async () => {
  await launched?.close();
  await direct?.close();
  await database?.drop();
});

function toolbar(): Locator {
  return page.getByTestId('connection-toolbar');
}

function tool(label: string): Locator {
  return toolbar().getByRole('button', { name: label, exact: true });
}

function profileItem(name: string): Locator {
  return page.getByRole('treeitem', { name, exact: true });
}

function treeRow(scope: Locator, text: string): Locator {
  return scope.locator('[data-tree-row]').filter({ has: page.getByText(text, { exact: true }) });
}

function tab(text: string | RegExp): Locator {
  return page.locator('.dv-tab', { hasText: text });
}

/** Picks an item in the palette's list, after checking what it asks. */
async function choose(question: string, item: string): Promise<void> {
  const pick = page.getByRole('dialog', { name: 'Choose' });
  await expect(pick.getByRole('combobox')).toHaveAccessibleName(question);
  // A follow-up question reuses the same list, so this does not wait for it to close.
  await pick.getByRole('option', { name: item, exact: true }).click();
}

/** Saves a connection from a pasted URI and opens it. */
async function addConnection(url: string, name: string): Promise<Locator> {
  await openNewConnection(page);
  const dialog = page.getByRole('dialog', { name: 'New connection' });
  await dialog.getByLabel('Paste a URI to fill the form').fill(url);
  await dialog.getByRole('button', { name: 'Fill from URI' }).click();
  await expect(dialog.getByText('Filled from the URI')).toBeVisible();
  await dialog.getByLabel('Name', { exact: true }).fill(name);
  await dialog.getByLabel('Password storage').selectOption('session');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
  const profile = profileItem(name);
  await profile.locator('[data-tree-row]').first().dblclick();
  await expect(profile.getByText('Connected', { exact: true })).toBeAttached();
  return profile;
}

test('shows no toolbar until a connection is open', async () => {
  await expect(toolbar()).toHaveCount(0);
});

test('acts on the PostgreSQL database, schema and table in front', async () => {
  test.skip(!PG_URL, 'Set QUERYBARA_TEST_POSTGRES_URL');
  const profile = await addConnection(database!.url, PG_NAME);
  await expect(page.getByRole('toolbar', { name: 'PostgreSQL' })).toBeVisible();
  await expect(toolbar()).toHaveAttribute('data-engine', 'postgres');
  await expect(tool('ER Diagram')).toBeEnabled();

  // With the database picked in the side bar, Table asks for the schema, then the table.
  await treeRow(profile, database!.name).click();
  await tool('Table').click();
  await choose(`Which schema of ${database!.name}?`, 'public');
  await choose(`Which table of ${database!.name}.public?`, 'tb_orders');
  const data = page.getByTestId('table-data-panel').filter({ visible: true });
  await expect(data).toBeVisible();

  // With the table's data in front, Export starts on it, and the server tools open.
  await tool('Export').click();
  const exporting = page.getByRole('dialog', { name: /Export/ });
  await expect(exporting).toBeVisible();
  await expect(exporting.getByText('tb_orders').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(exporting).toBeHidden();
  await tool('Monitor').click();
  const tools = page.getByTestId('server-tools-panel').filter({ visible: true });
  await expect(tools.getByRole('tab', { name: 'Monitor' })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  // A new query and the ER diagram open on the database picked in the side bar.
  await tool('Query').click();
  await expect(tab(`${database!.name} query`)).toHaveCount(1);
  await tool('ER Diagram').click();
  await expect(page.getByTestId('er-diagram').filter({ visible: true })).toBeVisible();
});

test('switches to the Redis tools with a Redis tab in front, and back', async () => {
  test.skip(!REDIS_URL, 'Set QUERYBARA_TEST_REDIS_URL');
  const profile = await addConnection(REDIS_URL!, REDIS_NAME);
  // Opening a database opens its key browser: a Redis tab in front.
  await treeRow(profile, 'db0').dblclick();
  await expect(page.getByTestId('key-browser').filter({ visible: true })).toBeVisible();
  await expect(page.getByRole('toolbar', { name: 'Redis' })).toBeVisible();
  await tool('CLI').click();
  await expect(page.getByTestId('redis-cli').filter({ visible: true })).toBeVisible();
  await tool('Dashboard').click();
  await expect(tab(`INFO dashboard · ${REDIS_NAME}`)).toHaveCount(1);

  if (PG_URL) {
    // Back on the PostgreSQL table: the SQL tools again.
    await tab('tb_orders').first().click();
    await expect(page.getByRole('toolbar', { name: 'PostgreSQL' })).toBeVisible();
  }
});

test('offers the Elasticsearch tools with its console in front', async () => {
  test.skip(!ES_URL, 'Set QUERYBARA_TEST_ELASTICSEARCH_URL');
  const profile = await addConnection(ES_URL!, ES_NAME);
  await treeRow(profile, 'Console').dblclick();
  await expect(page.getByRole('toolbar', { name: 'Elasticsearch' })).toBeVisible();
  await tool('Cluster').click();
  await expect(page.getByTestId('search-cluster').filter({ visible: true })).toBeVisible();
  await tool('New Index').click();
  const create = page.getByRole('dialog', { name: 'Create index' });
  await expect(create).toBeVisible();
  await create.getByRole('button', { name: 'Cancel' }).click();
  await expect(create).toBeHidden();
});

test('hides and shows with Ctrl+Alt+B', async () => {
  test.skip(!PG_URL && !REDIS_URL && !ES_URL, 'Needs a connection');
  await expect(toolbar()).toBeVisible();
  await page.keyboard.press('Control+Alt+b');
  await expect(toolbar()).toHaveCount(0);
  await page.keyboard.press('Control+Alt+b');
  await expect(toolbar()).toBeVisible();
});
