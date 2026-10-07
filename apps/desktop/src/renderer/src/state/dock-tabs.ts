import { create } from 'zustand';

/**
 * The dock's tab strip as VS Code's: pinned tabs stay left of the others and out of the bulk
 * closes of a tab's context menu (Close Others, Close to the Right, Close Saved, Close All),
 * which act on the tab's own group.
 */

interface TabPinsState {
  /** Pinned tab ids. */
  readonly pinned: Readonly<Record<string, true>>;
}

export const useTabPins = create<TabPinsState>()(() => ({ pinned: {} }));

export function isPinned(id: string): boolean {
  return useTabPins.getState().pinned[id] === true;
}

export function setPinned(id: string, pinned: boolean): void {
  useTabPins.setState((state) => {
    if ((state.pinned[id] === true) === pinned) return state;
    const { [id]: _was, ...rest } = state.pinned;
    return { pinned: pinned ? { ...rest, [id]: true } : rest };
  });
}

/**
 * Where a tab goes in its group's strip once (un)pinned: right after the group's other pinned
 * tabs, so the pinned ones stay first.
 */
export function pinnedSlot(order: readonly string[], id: string): number {
  return order.filter((other) => other !== id && isPinned(other)).length;
}

export type BulkClose = 'others' | 'right' | 'saved' | 'all';

/**
 * The tabs of a group (`order`, as the strip shows them) a bulk close from the tab `id` takes:
 * never a pinned one, and for "saved" none with work that closing would lose.
 */
export function tabsToClose(
  scope: BulkClose,
  order: readonly string[],
  id: string,
  unsaved: (id: string) => boolean,
): readonly string[] {
  const at = order.indexOf(id);
  return order.filter((other, index) => {
    if (isPinned(other)) return false;
    switch (scope) {
      case 'others':
        return other !== id;
      case 'right':
        return at !== -1 && index > at;
      case 'saved':
        return !unsaved(other);
      case 'all':
        return true;
    }
  });
}
