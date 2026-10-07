import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Locator, type Page } from '@playwright/test';

import { connectionTab, launchApp, openNewConnection, type LaunchedApp } from './app';

/**
 * The dock's tabs and the side bar's folders: a connection's colour along the top of its tabs;
 * a tooltip half a second into a hover naming the tab's database and connection, as Navicat's;
 * a middle click closing a tab; a right click opening VS Code's tab menu (the closes, pinning,
 * moving into a split); and folders that show an open glyph while open and start closed each
 * time the app opens. Screenshots go to QUERYBARA_E2E_SHOTS when it is set.
 */

const PG_URL = process.env['QUERYBARA_TEST_POSTGRES_URL'];
const SHOTS = process.env['QUERYBARA_E2E_SHOTS'];
const NAME = 'E2E Tabs shop';
const COLOR = '#e5484d';

test.skip(!PG_URL, 'Set QUERYBARA_TEST_POSTGRES_URL to run the end-to-end tests');

test.describe.configure({ mode: 'serial' });

const userData = mkdtempSync(join(tmpdir(), 'querybara-e2e-tabs-'));
let launched: LaunchedApp | undefined;
let page: Page;

test.beforeAll(async () => {
  launched = await launchApp({ userData });
  page = launched.page;
});

test.afterAll(async () => {
  await launched?.close();
  rmSync(userData, { recursive: true, force: true });
});

async function shot(name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

const tabs = (): Locator => page.getByTestId('dock-tab');
const profile = (): Locator => page.getByRole('treeitem', { name: NAME, exact: true });
const folder = (): Locator =>
  page.getByRole('treeitem').filter({
    has: page.locator(':scope > [data-tree-row]').getByText('Folder 1', { exact: true }),
  });
const folderIcon = (): Locator =>
  folder().locator(':scope > [data-tree-row] svg[data-icon^="folder"]');

async function newQuery(): Promise<void> {
  const before = await tabs().count();
  await page.getByRole('button', { name: 'New query' }).click();
  await expect(tabs()).toHaveCount(before + 1);
}

async function tabMenu(tab: Locator, item: string): Promise<void> {
  await tab.click({ button: 'right' });
  await page
    .getByRole('menu', { name: 'Tab actions' })
    .getByRole('menuitem', { name: item })
    .click();
}

test('a connection in a folder: the folder shows open while open', async () => {
  await openNewConnection(page);
  const dialog = page.getByRole('dialog', { name: 'New connection' });
  await dialog.getByLabel('Paste a URI to fill the form').fill(PG_URL!);
  await dialog.getByRole('button', { name: 'Fill from URI' }).click();
  await expect(dialog.getByText('Filled from the URI')).toBeVisible();
  await dialog.getByLabel('Name', { exact: true }).fill(NAME);
  await dialog.getByLabel('Password storage').selectOption('session');
  await connectionTab(dialog, 'Advanced');
  await dialog.getByLabel('Colour').fill(COLOR);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();

  await page.getByRole('button', { name: 'Connection actions' }).click();
  await page.getByRole('menuitem', { name: 'New folder' }).click();
  await page.getByRole('tree').getByRole('textbox').press('Enter');
  // A new, empty folder is closed.
  await expect(folder()).toHaveAttribute('aria-expanded', 'false');
  await expect(folderIcon()).toHaveAttribute('data-icon', 'folder');

  // Moving the connection in opens the folder to show it there.
  await profile().locator('[data-tree-row]').first().hover();
  await profile().getByRole('button', { name: 'Actions' }).first().click();
  await page.getByRole('menuitem', { name: 'Move to folder' }).click();
  await page.getByRole('menuitem', { name: 'Folder 1' }).click();
  await expect(folder()).toHaveAttribute('aria-expanded', 'true');
  await expect(folderIcon()).toHaveAttribute('data-icon', 'folder-open');
  await expect(folder().getByRole('treeitem', { name: NAME })).toBeVisible();
});

test("a connection's tabs wear its colour, and their tooltip names the database", async () => {
  await profile().locator('[data-tree-row]').first().dblclick();
  await expect(profile().getByText('Connected', { exact: true })).toBeAttached();
  await newQuery();

  const tab = tabs().first();
  await expect(tab.getByTestId('tab-connection-color')).toHaveCSS(
    'background-color',
    'rgb(229, 72, 77)',
  );

  await tab.hover();
  const tooltip = page.getByTestId('tab-tooltip');
  // Half a second into the hover.
  await expect(tooltip).toBeVisible({ timeout: 1_500 });
  const database = new URL(PG_URL!).pathname.slice(1);
  await expect(tooltip).toContainText(`${NAME} query@${database}`);
  await expect(tooltip).toContainText(`(${NAME} (PostgreSQL))`);
  await shot('tab-tooltip');
  await page.mouse.move(0, 400);
});

test('a middle click closes a tab', async () => {
  await newQuery();
  await expect(tabs()).toHaveCount(2);
  await tabs().last().click({ button: 'middle' });
  await expect(tabs()).toHaveCount(1);
});

test('the tab menu closes others, to the right, and all, but never a pinned tab', async () => {
  await newQuery();
  await newQuery();
  await newQuery();
  await expect(tabs()).toHaveCount(4);

  await tabs().nth(1).click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Tab actions' });
  // Close carries its key ("Close Ctrl+W").
  await expect(menu.getByRole('menuitem', { name: /^Close (Ctrl\+W|⌘W)$/ })).toBeVisible();
  for (const item of [
    'Close Others',
    'Close to the Right',
    'Close Saved',
    'Close All',
    'Pin',
    'Split & Move',
  ]) {
    await expect(menu.getByRole('menuitem', { name: item, exact: true })).toBeVisible();
  }
  await shot('tab-menu');
  await page.keyboard.press('Escape');

  await tabMenu(tabs().nth(1), 'Close to the Right');
  await expect(tabs()).toHaveCount(2);

  // A pinned tab moves first, wears a pin in place of its close button, and stays put.
  await tabMenu(tabs().nth(1), 'Pin');
  await expect(
    tabs()
      .first()
      .getByRole('button', { name: /^Unpin/ }),
  ).toBeVisible();
  await newQuery();
  await newQuery();
  await tabMenu(tabs().last(), 'Close Others');
  await expect(tabs()).toHaveCount(2);
  await tabMenu(tabs().last(), 'Close All');
  await expect(tabs()).toHaveCount(1);
  await expect(
    tabs()
      .first()
      .getByRole('button', { name: /^Unpin/ }),
  ).toBeVisible();

  // Unpinned, it closes like any other.
  await tabs()
    .first()
    .getByRole('button', { name: /^Unpin/ })
    .click();
  await tabMenu(tabs().first(), 'Close All');
  await expect(tabs()).toHaveCount(0);
});

test('Split & Move moves a tab into a new group beside its own', async () => {
  await newQuery();
  await newQuery();
  await tabs().last().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Split & Move' }).click();
  await page.getByRole('menuitem', { name: 'Split Right' }).click();
  await expect(page.locator('.dv-groupview')).toHaveCount(2);
  await shot('tab-split');
});

test('every folder is closed when the app opens again', async () => {
  await launched?.app.close();
  launched = await launchApp({ userData });
  page = launched.page;
  await expect(folder()).toHaveAttribute('aria-expanded', 'false');
  await expect(folderIcon()).toHaveAttribute('data-icon', 'folder');
  await expect(profile()).toHaveCount(0);
});
