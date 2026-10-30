import { expect, test } from '@playwright/test';

import { launchApp, openNewConnection } from './app';

/**
 * A connection that fails says why in a toast, once, not in the side bar, and closing the toast
 * puts the connection back to "Not connected". No server is needed: the port refuses.
 */

const SHOTS = process.env['QUERYBARA_E2E_SHOTS'];

test('a failed connection shows its error in a toast once, and the toast can be closed', async () => {
  const launched = await launchApp();
  const page = launched.page;
  try {
    await openNewConnection(page);
    const dialog = page.getByRole('dialog', { name: 'New connection' });
    await dialog.getByLabel('Paste a URI to fill the form').fill('redis://127.0.0.1:1');
    await dialog.getByRole('button', { name: 'Fill from URI' }).click();
    await dialog.getByLabel('Name', { exact: true }).fill('E2E Nowhere');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();

    const profile = page.getByRole('treeitem', { name: 'E2E Nowhere', exact: true });
    await profile.locator('[data-tree-row]').first().dblclick();
    await expect(profile.getByText('Failed', { exact: true })).toBeAttached();
    const toast = page.getByTestId('toast');
    await expect(toast).toHaveCount(1);
    await expect(toast).toContainText('E2E Nowhere');
    // Not written into the side bar.
    const sidebar = page.getByRole('complementary', { name: 'Connections' });
    await expect(sidebar.getByRole('button', { name: 'Dismiss the error' })).toHaveCount(0);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/connection-error.png` });
    await toast.getByRole('button', { name: 'Dismiss the error' }).click();
    await expect(toast).toHaveCount(0);
    await expect(profile.getByText('Not connected', { exact: true })).toBeAttached();
  } finally {
    await launched.close();
  }
});
