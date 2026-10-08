import type { KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react';

import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  keepSidebar,
  setSidebarWidth,
  useSidebar,
} from '../state/sidebar';

/** Room the query tabs keep when the side bar is dragged wide. */
const MAIN_MIN_WIDTH = 320;
/** Keyboard steps of the splitter: arrows, and with Shift. */
const STEP = 16;
const BIG_STEP = 64;

/**
 * The side bar's column, as VS Code's: dragging its right edge resizes it, dragging it narrower
 * than half its minimum hides it (dragging back out shows it again), a double click puts the
 * default width back. Hidden, it stays mounted, so its tree, filter and scroll survive.
 */
export function SidebarPane(props: { readonly children: ReactNode }) {
  const width = useSidebar((state) => state.width);
  const visible = useSidebar((state) => state.visible);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    const left = event.currentTarget.parentElement?.getBoundingClientRect().left ?? 0;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    const { cursor, userSelect } = document.body.style;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const move = (e: PointerEvent): void => {
      const x = e.clientX - left;
      if (x < SIDEBAR_MIN_WIDTH / 2) {
        useSidebar.setState({ visible: false });
        return;
      }
      setSidebarWidth(Math.min(x, window.innerWidth - MAIN_MIN_WIDTH), false);
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      document.body.style.cursor = cursor;
      document.body.style.userSelect = userSelect;
      keepSidebar();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? BIG_STEP : STEP;
    const next =
      event.key === 'ArrowLeft'
        ? width - step
        : event.key === 'ArrowRight'
          ? width + step
          : event.key === 'Home'
            ? SIDEBAR_MIN_WIDTH
            : event.key === 'End'
              ? SIDEBAR_MAX_WIDTH
              : undefined;
    if (next === undefined) return;
    event.preventDefault();
    setSidebarWidth(next);
  };

  return (
    <div
      className={visible ? 'relative shrink-0' : 'hidden'}
      style={{ width }}
      data-testid="sidebar-pane"
    >
      {props.children}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize side bar"
        aria-valuenow={width}
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={SIDEBAR_MAX_WIDTH}
        tabIndex={0}
        title="Drag to resize, double-click to reset"
        className="absolute inset-y-0 -right-0.5 z-10 w-1 cursor-col-resize outline-none hover:bg-focus focus-visible:bg-focus active:bg-focus"
        onPointerDown={startResize}
        onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
