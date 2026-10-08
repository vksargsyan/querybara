import { create } from 'zustand';

/**
 * The side bar's width and whether it shows. Dragged by the splitter at its right edge, hidden
 * with Toggle Side Bar (or by dragging it narrower than it goes), and kept in this browser
 * profile: a convenience, not a setting.
 */

export const SIDEBAR_DEFAULT_WIDTH = 288;
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 640;

interface SidebarState {
  readonly width: number;
  readonly visible: boolean;
}

const KEY = 'querybara.sidebar';

const DEFAULTS: SidebarState = { width: SIDEBAR_DEFAULT_WIDTH, visible: true };

/** A width the side bar can have. */
export function clampSidebarWidth(width: number): number {
  return Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width)));
}

/** The stored state, or the defaults for anything missing or malformed. */
export function parseSidebar(text: string | null): SidebarState {
  if (text === null) return DEFAULTS;
  try {
    const stored = JSON.parse(text) as Partial<Record<keyof SidebarState, unknown>> | null;
    return {
      width:
        typeof stored?.width === 'number' && Number.isFinite(stored.width)
          ? clampSidebarWidth(stored.width)
          : DEFAULTS.width,
      visible: typeof stored?.visible === 'boolean' ? stored.visible : DEFAULTS.visible,
    };
  } catch {
    return DEFAULTS;
  }
}

function read(): SidebarState {
  try {
    return parseSidebar(localStorage.getItem(KEY));
  } catch {
    return DEFAULTS;
  }
}

export const useSidebar = create<SidebarState>()(() =>
  typeof localStorage === 'undefined' ? DEFAULTS : read(),
);

function save(): void {
  const { width, visible } = useSidebar.getState();
  try {
    localStorage.setItem(KEY, JSON.stringify({ width, visible }));
  } catch {
    // Not kept: the next window starts with the default.
  }
}

/** Sets the width while dragging; `keep` stores it (at the end of a drag, or from the keyboard). */
export function setSidebarWidth(width: number, keep = true): void {
  useSidebar.setState({ width: clampSidebarWidth(width), visible: true });
  if (keep) save();
}

/** Shows or hides the side bar; without `visible`, toggles it. */
export function showSidebar(visible = !useSidebar.getState().visible): void {
  useSidebar.setState({ visible });
  save();
}

/** Stores the state as it is now (after a drag). */
export function keepSidebar(): void {
  save();
}
