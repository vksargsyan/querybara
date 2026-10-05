import { createCipheriv } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { launchApp, openNewConnection, type LaunchedApp } from './app';

/**
 * Import and export of connections, with no server: connections export to an encrypted file
 * from the side bar's menu, the file imports into a fresh app with its passphrase, and a Navicat
 * `.ncx` file imports with its saved password. Native file dialogs are stubbed.
 */

const SHOTS = process.env['QUERYBARA_E2E_SHOTS'];

test.describe.configure({ mode: 'serial' });

let dir: string;
const opened: LaunchedApp[] = [];

test.beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'querybara-e2e-files-'));
});

test.afterAll(async () => {
  for (const app of opened.splice(0)) await app.close();
  rmSync(dir, { recursive: true, force: true });
});

async function launch(): Promise<LaunchedApp> {
  const launched = await launchApp();
  opened.push(launched);
  return launched;
}

/** The next native open or save dialog answers with `path`. */
async function stubDialog(launched: LaunchedApp, kind: 'open' | 'save', path: string) {
  await launched.app.evaluate(
    ({ dialog }, [which, file]) => {
      if (which === 'open') {
        dialog.showOpenDialog = (() =>
          Promise.resolve({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog;
      } else {
        dialog.showSaveDialog = (() =>
          Promise.resolve({ canceled: false, filePath: file })) as typeof dialog.showSaveDialog;
      }
    },
    [kind, path] as const,
  );
}

async function actions(page: Page, item: string): Promise<void> {
  await page.getByRole('button', { name: 'Connection actions' }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

async function create(page: Page, uri: string, name: string): Promise<void> {
  await openNewConnection(page);
  const dialog = page.getByRole('dialog', { name: 'New connection' });
  await dialog.getByLabel('Paste a URI to fill the form').fill(uri);
  await dialog.getByRole('button', { name: 'Fill from URI' }).click();
  await expect(dialog.getByText('Filled from the URI')).toBeVisible();
  await dialog.getByLabel('Name', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
}

const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

test('exports connections to an encrypted file and imports them elsewhere', async () => {
  const source = await launch();
  const page = source.page;
  await create(page, 'postgres://app:pg-secret-1@db.example.com:5432/shop', 'E2E Shop');
  await create(page, 'redis://cache.example.com:6380/2', 'E2E Cache');

  const file = join(dir, 'connections.qbx');
  await actions(page, 'Export connections…');
  const exporting = page.getByRole('dialog', { name: 'Export connections' });
  await expect(exporting.getByLabel('All connections (2)')).toBeChecked();
  await exporting.getByLabel('Include saved passwords').check();
  await exporting.getByLabel('Passphrase', { exact: true }).fill('e2e passphrase');
  await exporting.getByLabel('Repeat the passphrase').fill('e2e passphrase!');
  await expect(exporting.getByText('The passphrases do not match')).toBeVisible();
  await expect(exporting.getByRole('button', { name: 'Export…' })).toBeDisabled();
  await exporting.getByLabel('Repeat the passphrase').fill('e2e passphrase');
  await shot(page, 'export-dialog');
  await stubDialog(source, 'save', file);
  await exporting.getByRole('button', { name: 'Export…' }).click();
  await expect(exporting).toBeHidden();
  await expect(page.getByText(/Exported 2 connections with \d passwords?\./)).toBeVisible();
  expect(readFileSync(file).includes(Buffer.from('pg-secret-1'))).toBe(false);

  const target = await launch();
  const other = target.page;
  await stubDialog(target, 'open', file);
  await actions(other, 'Import connections…');
  const importing = other.getByRole('dialog', { name: 'Import connections' });
  await importing.getByRole('button', { name: 'Choose file…' }).click();
  await importing.getByLabel('Passphrase').fill('wrong');
  await importing.getByRole('button', { name: 'Open' }).click();
  await expect(importing.getByRole('alert')).toBeVisible();
  await importing.getByLabel('Passphrase').fill('e2e passphrase');
  await importing.getByRole('button', { name: 'Open' }).click();
  const list = importing.getByRole('list', { name: 'Connections in the file' });
  await expect(list.getByText('E2E Shop')).toBeVisible();
  await expect(list.getByText('db.example.com:5432')).toBeVisible();
  await shot(other, 'import-dialog');
  await importing.getByRole('button', { name: 'Import 2' }).click();
  await expect(importing).toBeHidden();
  await expect(other.getByRole('treeitem', { name: 'E2E Shop', exact: true })).toBeVisible();
  await expect(other.getByRole('treeitem', { name: 'E2E Cache', exact: true })).toBeVisible();

  // Again: both exist now, and are only replaced when asked.
  await actions(other, 'Import connections…');
  await importing.getByRole('button', { name: 'Choose file…' }).click();
  await importing.getByLabel('Passphrase').fill('e2e passphrase');
  await importing.getByRole('button', { name: 'Open' }).click();
  await expect(importing.getByText('Exists “E2E Shop”')).toBeVisible();
  await expect(importing.getByRole('button', { name: 'Import', exact: true })).toBeDisabled();
  await importing.getByLabel('Replace the 2 connections that already exist').check();
  await importing.getByRole('button', { name: 'Import 2' }).click();
  await expect(other.getByText('Imported 2 connections (2 replaced)')).toBeVisible();
});

test('imports a Navicat connections file', async () => {
  const cipher = createCipheriv(
    'aes-128-cbc',
    Buffer.from('libcckeylibcckey'),
    Buffer.from('libcciv libcciv '),
  );
  const saved = Buffer.concat([cipher.update('navicat-secret'), cipher.final()])
    .toString('hex')
    .toUpperCase();
  const file = join(dir, 'navicat.ncx');
  writeFileSync(
    file,
    `<?xml version="1.0" encoding="UTF-8"?>
<Connections Ver="1.5">
  <Connection ConnectionName="E2E Orders" ConnType="MYSQL" Host="mysql.example.com" Port="3306" UserName="app" Password="${saved}" SavePassword="true" SSL="false" SSH="true" SSH_Host="bastion.example.com" SSH_Port="22" SSH_UserName="ops" SSH_AuthenMethod="PUBLICKEY" SSH_PrivateKey="/home/ops/.ssh/id_ed25519" HTTP="false"/>
  <Connection ConnectionName="E2E Reports" ConnType="POSTGRESQL" Host="pg.example.com" Port="5432" UserName="reports" Password="" SavePassword="false" HTTP="true"/>
  <Connection ConnectionName="E2E Legacy" ConnType="ORACLE" Host="ora.example.com" Port="1521"/>
</Connections>
`,
  );
  const launched = await launch();
  const page = launched.page;
  await stubDialog(launched, 'open', file);
  await page.getByText('Connections', { exact: true }).first().click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+P' : 'Control+Shift+P');
  await page.keyboard.type('Import Connections');
  await page.keyboard.press('Enter');
  const importing = page.getByRole('dialog', { name: 'Import connections' });
  await importing.getByRole('button', { name: 'Choose file…' }).click();
  await expect(importing.getByText('Navicat connections')).toBeVisible();
  await expect(importing.getByText('1 saved password')).toBeVisible();
  await expect(importing.getByText('HTTP tunnels are not supported')).toBeVisible();
  await expect(
    importing.getByText('E2E Legacy: Oracle connections are not supported'),
  ).toBeVisible();
  await shot(page, 'import-navicat');
  await importing.getByRole('button', { name: 'Import 2' }).click();
  await expect(importing).toBeHidden();
  await expect(page.getByRole('treeitem', { name: 'E2E Orders', exact: true })).toBeVisible();
  await expect(page.getByRole('treeitem', { name: 'E2E Reports', exact: true })).toBeVisible();
});

test('the Compare menu shows a glyph for each item', async () => {
  const launched = await launch();
  const page = launched.page;
  await page.getByRole('button', { name: 'Compare' }).click();
  const items = page.getByRole('menuitem');
  await expect(items).toHaveCount(3);
  for (const item of await items.all()) await expect(item.locator('svg')).toHaveCount(1);
  await shot(page, 'compare-menu');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Connection actions' }).click();
  await shot(page, 'connection-actions');
});
