import { useCallback, useRef } from 'react';

/**
 * Navicat's object keys (⌘O open, ⌘D design, ⌘N new table) for the item with the keyboard
 * focus: a row of the side bar's tree, the Objects view's selection, or the menu open on either.
 * Each of them provides what its keys do, found by walking up from the focused element; the
 * commands bound to the keys (explorer.*) run it, and are enabled only where it applies, so the
 * same key does something else elsewhere (⌘D inserts a document in a collection tab).
 */

export interface ObjectShortcuts {
  /** ⌘O: a table's data, a view's rows, a collection's documents. */
  readonly open?: (() => void) | undefined;
  /** ⌘D: the table designer. */
  readonly design?: (() => void) | undefined;
  /** ⌘N: a new table (or collection) in the database, schema or folder. */
  readonly create?: (() => void) | undefined;
}

export type ObjectShortcut = keyof ObjectShortcuts;

const providers = new WeakMap<Element, () => ObjectShortcuts | undefined>();

/** What the keys do for the focused element, from the nearest element that provides them. */
export function focusedShortcuts(
  focused: Element | null = typeof document === 'undefined' ? null : document.activeElement,
): ObjectShortcuts {
  for (let element = focused; element; element = element.parentElement) {
    const provider = providers.get(element);
    if (provider) return provider() ?? {};
  }
  return {};
}

/** Whether the focused item does something on `key`. */
export function hasShortcut(key: ObjectShortcut): boolean {
  return focusedShortcuts()[key] !== undefined;
}

/** Runs what the focused item does on `key`, if anything. */
export function runShortcut(key: ObjectShortcut): void {
  focusedShortcuts()[key]?.();
}

/** Makes `element` (and what it holds) provide `provider`'s keys; `undefined` stops it. */
export function provideShortcuts(
  element: Element,
  provider: (() => ObjectShortcuts | undefined) | undefined,
): void {
  if (provider) providers.set(element, provider);
  else providers.delete(element);
}

/**
 * A ref for the element that provides `shortcuts` (read when a key is pressed, so they may
 * change from render to render). `onRun` comes first when one runs: an open menu closes.
 */
export function useShortcutsRef<T extends Element>(
  shortcuts: ObjectShortcuts | undefined,
  onRun?: () => void,
): (element: T | null) => void {
  const latest = useRef({ shortcuts, onRun });
  latest.current = { shortcuts, onRun };
  return useCallback((element: T | null) => {
    if (!element) return;
    provideShortcuts(element, () => {
      const { shortcuts: current, onRun: before } = latest.current;
      if (!current || !before) return current;
      const wrap = (action: (() => void) | undefined) =>
        action &&
        (() => {
          before();
          action();
        });
      return {
        open: wrap(current.open),
        design: wrap(current.design),
        create: wrap(current.create),
      };
    });
  }, []);
}
