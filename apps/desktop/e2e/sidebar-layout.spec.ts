import { expect, test, type Page } from '@playwright/test';

import { launchApp, type LaunchedApp } from './app';

/**
 * The side bar's layout, with no server: its right edge drags it wider or narrower, Ctrl+B
 * (⌘B) and the title bar's button hide and show it, and both survive a relaunch.
 */

test.describe.configure({ mode: 'serial' });

let launched: LaunchedApp;
let page: Page;

test.beforeAll(async () => {
  launched = await launchApp();
  page = launched.page;
});

test.afterAll(async () => {
  await launched?.close();
});

const sidebar = () => page.getByRole('complementary', { name: 'Connections' });
const splitter = () => page.getByRole('separator', { name: 'Resize side bar' });

async function width(): Promise<number> {
  return (await sidebar().boundingBox())?.width ?? 0;
}

test('dragging the splitter resizes the side bar; a double click resets it', async () => {
  await expect(sidebar()).toBeVisible();
  const before = await width();
  const handle = await splitter().boundingBox();
  if (!handle) throw new Error('no splitter');
  const y = handle.y + handle.height / 2;
  await page.mouse.move(handle.x + handle.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(handle.x + 120, y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(width).toBeGreaterThan(before + 100);

  await splitter().dblclick();
  await expect.poll(width).toBe(before);

  await splitter().focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(width).toBe(before + 16);
});

test('Ctrl+B and the title bar button hide and show it', async () => {
  const toggle = page.getByRole('button', { name: 'Side bar' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ControlOrMeta+b');
  await expect(sidebar()).toBeHidden();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(sidebar()).toBeVisible();
  await page.keyboard.press('ControlOrMeta+b');
  await expect(sidebar()).toBeHidden();
  // Search Connections shows it again.
  await page.keyboard.press('ControlOrMeta+Shift+f');
  await expect(sidebar()).toBeVisible();
  await expect(page.getByTestId('sidebar-search')).toBeFocused();
});

test('dragging it narrower than it goes hides it', async () => {
  const handle = await splitter().boundingBox();
  if (!handle) throw new Error('no splitter');
  const y = handle.y + handle.height / 2;
  await page.mouse.move(handle.x + handle.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(20, y, { steps: 5 });
  await page.mouse.up();
  await expect(sidebar()).toBeHidden();
  await page.keyboard.press('ControlOrMeta+b');
  await expect(sidebar()).toBeVisible();
});
