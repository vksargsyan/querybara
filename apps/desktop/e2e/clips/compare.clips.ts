import { expect, test } from '@playwright/test';

import { DEMO } from '../screenshots/harness';
import { visible } from '../screenshots/nosql';
import { film } from './director';

/**
 * Structure sync on Larchwood and its drifted staging copy, applied so the staging database
 * changes. Scenes run one file at a time in name order and this file comes first: the ER scene
 * (sql.clips.ts) adds loyalty_tier to the customers, which would turn the drop this scene shows
 * into an alter.
 */

test('structure-sync', async () => {
  await film(
    {
      connections: [DEMO.postgres, DEMO.postgresStaging],
      connect: [DEMO.postgres.name],
    },
    async (clip) => {
      const { page } = clip;
      await page
        .getByRole('toolbar', { name: 'Window' })
        .getByRole('button', { name: 'Compare' })
        .click();
      await page.getByRole('menuitem', { name: 'Compare structure…' }).click();
      const view = visible(page, 'structure-compare');
      const side = async (role: 'Source' | 'Target', profile: string, database: string) => {
        await view
          .getByLabel(`${role} connection`)
          .selectOption({ label: `${profile} · PostgreSQL` });
        await view.getByLabel(`${role} database`).fill(database);
        await view.getByLabel(`${role} schemas`).fill('shop');
      };
      await side('Source', DEMO.postgres.name, 'larchwood');
      await side('Target', DEMO.postgresStaging.name, 'larchwood_staging');

      await clip.start('structure-sync');
      await clip.show('Larchwood and its staging copy: compare schema shop', 1800);
      await clip.click(view.getByRole('button', { name: 'Compare', exact: true }));
      const summary = view.getByTestId('sync-summary');
      await expect(summary).toBeVisible({ timeout: 60_000 });
      await clip.show('The differences, grouped by object', 2200);
      await clip.click(view.getByRole('button', { name: 'shop.products.price' }));
      await expect(view.getByTestId('source-ddl')).toBeVisible();
      await clip.show('One difference: both definitions side by side', 2400);
      await clip.click(view.getByRole('tab', { name: 'Script' }));
      await expect(view.getByTestId('sync-script')).toContainText('ALTER');
      await clip.show('The script that makes staging match', 2200);
      await clip.click(view.getByRole('button', { name: 'Select all', exact: true }));
      await expect(view.getByText(/^\d+ destructive operations? ticked$/)).toBeVisible();
      await clip.show('Select all: the destructive drop is ticked too', 1200);
      await clip.click(view.getByRole('button', { name: 'Apply…' }));
      const review = page.getByRole('alertdialog', { name: 'Review and apply' });
      await expect(review.getByTestId('apply-script')).not.toHaveText('Generating the script…');
      await clip.show('Review and apply: every statement before it runs', 2400);
      const tick = review.getByRole('checkbox', { name: /^I reviewed this script/ });
      if ((await tick.count()) > 0) await clip.check(tick);
      await clip.click(review.getByRole('button', { name: 'Apply', exact: true }));
      await expect(view.getByText(/^No differences:/)).toBeVisible({ timeout: 120_000 });
      await clip.show('Applied and compared again: zero differences', 2800);
    },
  );
});
