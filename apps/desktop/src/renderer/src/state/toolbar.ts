import { create } from 'zustand';

/**
 * Whether the connection toolbar shows (ADR 0042): a convenience kept in this browser profile,
 * on by default. The MongoDB-only toolbar it grew from kept the same choice under its own key,
 * which is still read.
 */

const KEY = 'querybara.toolbar';
const LEGACY_KEY = 'querybara.mongoToolbar';

function readVisible(): boolean {
  try {
    return (localStorage.getItem(KEY) ?? localStorage.getItem(LEGACY_KEY)) !== 'hidden';
  } catch {
    return true;
  }
}

export const useToolbar = create<{ readonly visible: boolean }>()(() => ({
  visible: readVisible(),
}));

export function setToolbarVisible(visible: boolean): void {
  useToolbar.setState({ visible });
  try {
    localStorage.setItem(KEY, visible ? 'shown' : 'hidden');
  } catch {
    // Not kept: the next window shows it.
  }
}
