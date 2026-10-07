import { beforeEach, describe, expect, it } from 'vitest';

import {
  isPinned,
  pinnedSlot,
  setPinned,
  tabsToClose,
  useTabPins,
} from '../src/renderer/src/state/dock-tabs';
import { placeOf } from '../src/renderer/src/state/panels';

/** The dock's tab strip as VS Code's: pinned tabs, and what a tab menu's bulk closes take. */

const ORDER = ['a', 'b', 'c', 'd'];
const saved = (): boolean => false;

beforeEach(() => {
  useTabPins.setState({ pinned: {} });
});

describe('tabsToClose', () => {
  it('takes the others, those to the right, or all of the group', () => {
    expect(tabsToClose('others', ORDER, 'b', saved)).toEqual(['a', 'c', 'd']);
    expect(tabsToClose('right', ORDER, 'b', saved)).toEqual(['c', 'd']);
    expect(tabsToClose('right', ORDER, 'd', saved)).toEqual([]);
    expect(tabsToClose('all', ORDER, 'b', saved)).toEqual(ORDER);
  });

  it('leaves the tabs holding unsaved work to Close Saved', () => {
    expect(tabsToClose('saved', ORDER, 'a', (id) => id === 'c')).toEqual(['a', 'b', 'd']);
  });

  it('never takes a pinned tab', () => {
    setPinned('a', true);
    expect(tabsToClose('all', ORDER, 'b', saved)).toEqual(['b', 'c', 'd']);
    expect(tabsToClose('others', ORDER, 'b', saved)).toEqual(['c', 'd']);
    expect(tabsToClose('saved', ORDER, 'b', saved)).toEqual(['b', 'c', 'd']);
  });
});

describe('pinning', () => {
  it('places a tab after the group’s other pinned tabs', () => {
    expect(pinnedSlot(ORDER, 'c')).toBe(0);
    setPinned('a', true);
    setPinned('c', true);
    expect(pinnedSlot(ORDER, 'c')).toBe(1);
    expect(pinnedSlot(ORDER, 'd')).toBe(2);
  });

  it('unpins', () => {
    setPinned('a', true);
    expect(isPinned('a')).toBe(true);
    setPinned('a', false);
    expect(isPinned('a')).toBe(false);
  });
});

describe('placeOf', () => {
  it('names the database, or database.schema on PostgreSQL', () => {
    expect(placeOf('shop', 'public')).toBe('shop.public');
    expect(placeOf('shop', 'shop')).toBe('shop');
    expect(placeOf(undefined, 'shop')).toBe('shop');
    expect(placeOf('shop', undefined)).toBe('shop');
    expect(placeOf(undefined, undefined)).toBeUndefined();
  });
});
