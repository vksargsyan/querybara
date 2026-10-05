import { expect, test } from '@playwright/test';

import { launchApp, openNewConnection } from './app';

/**
 * A connection that fails shows why under it in the side bar, once, and the error can be
 * dismissed: the connection goes back to "Not connected". No server is needed: the port refuses.
 */

const SHOTS = process.env['QUERYBARA_E2E_SHOTS'];

test('a failed connection shows its error once, and the error can be dismissed', async () => {
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
    const dismiss = page.getByRole('button', { name: 'Dismiss the error' });
    // Under the connection only, not again at the top of the side bar.
    await expect(dismiss).toHaveCount(1);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/connection-error.png` });
    await dismiss.click();
    await expect(dismiss).toHaveCount(0);
    await expect(profile.getByText('Not connected', { exact: true })).toBeAttached();
  } finally {
    await launched.close();
  }
});
