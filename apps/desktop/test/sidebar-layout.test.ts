import { describe, expect, it } from 'vitest';

import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  clampSidebarWidth,
  parseSidebar,
  setSidebarWidth,
  showSidebar,
  useSidebar,
} from '../src/renderer/src/state/sidebar';

/** The side bar's width and visibility, as stored between runs. */

describe('side bar layout', () => {
  it('keeps the width between its minimum and maximum', () => {
    expect(clampSidebarWidth(20)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(5000)).toBe(SIDEBAR_MAX_WIDTH);
    expect(clampSidebarWidth(300.4)).toBe(300);
  });

  it('reads what was stored, and the defaults for anything else', () => {
    const defaults = { width: SIDEBAR_DEFAULT_WIDTH, visible: true };
    expect(parseSidebar(null)).toEqual(defaults);
    expect(parseSidebar('not json')).toEqual(defaults);
    expect(parseSidebar('null')).toEqual(defaults);
    expect(parseSidebar('{"width":"wide","visible":"no"}')).toEqual(defaults);
    expect(parseSidebar('{"width":360,"visible":false}')).toEqual({ width: 360, visible: false });
    expect(parseSidebar('{"width":9000}')).toEqual({ width: SIDEBAR_MAX_WIDTH, visible: true });
  });

  it('toggles, and shows again when resized', () => {
    useSidebar.setState({ width: SIDEBAR_DEFAULT_WIDTH, visible: true });
    showSidebar();
    expect(useSidebar.getState().visible).toBe(false);
    setSidebarWidth(400);
    expect(useSidebar.getState()).toEqual({ width: 400, visible: true });
    showSidebar(true);
    expect(useSidebar.getState().visible).toBe(true);
  });
});
