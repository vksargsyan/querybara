import { describe, expect, it } from 'vitest';

import { focusedShortcuts, provideShortcuts } from '../src/renderer/src/state/object-shortcuts';

/**
 * ⌘O, ⌘D and ⌘N act on the focused explorer item: the nearest element up from the focus that
 * provides them (a side bar row, the Objects grid, the menu open on either), and nothing else.
 */

function element(parent: Element | null = null): Element {
  return { parentElement: parent } as unknown as Element;
}

describe('the focused item’s keys', () => {
  it('come from the nearest providing element up from the focus', () => {
    const open = (): void => undefined;
    const row = element();
    const label = element(element(row));
    provideShortcuts(row, () => ({ open }));
    expect(focusedShortcuts(label).open).toBe(open);
    expect(focusedShortcuts(row).design).toBeUndefined();
  });

  it('stop at a provider with none, rather than reaching an outer one', () => {
    const outer = element();
    const inner = element(outer);
    provideShortcuts(outer, () => ({ create: () => undefined }));
    provideShortcuts(inner, () => undefined);
    expect(focusedShortcuts(inner)).toEqual({});
    provideShortcuts(inner, undefined);
    expect(focusedShortcuts(inner).create).toBeDefined();
  });

  it('are none away from the explorer', () => {
    expect(focusedShortcuts(element(element()))).toEqual({});
    expect(focusedShortcuts(null)).toEqual({});
  });
});
