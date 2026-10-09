import type { ReactNode } from 'react';

import { useWindowState } from '../state/window';
import { SyncMenu } from './sync/SyncMenu';
import { Icon, cx } from './ui';
import { bindingLabel } from '../lib/keys';
import { useBindingOf } from '../state/keybindings';
import { openPalette } from '../state/palette';
import { WindowMenuBar } from './WindowMenuBar';

/**
 * The window's title bar, drawn by the page as VS Code draws its own (the native one is hidden,
 * see main/window-chrome.ts), and under it the window's tools, as Navicat's toolbar: both on the
 * chrome ground, dragging the window. The title row is 35px; on macOS it leaves room for the
 * traffic lights (not in full screen, where they hide); on Windows and Linux for the window
 * controls overlaid at its right, with the menu bar at its left (the native one hides with the
 * native title bar). In its middle, the active tab's title, or on a production connection the
 * red banner naming it. The app's name is in the application menu only, and so is About.
 *
 * The tool stripe has a tile per tool, drawn as the new connection dialog's engine cards: a
 * glyph on a wash of its own glaze in a rounded square, the tool's name under it. Making things
 * at the left (a connection, a query, a table), the window's panels and tools in the middle, and
 * at the right the view switches (the side bar, the theme) in one pill, as Navicat's View.
 */

export function TitleBar(props: {
  readonly title: string | undefined;
  readonly production: string | undefined;
  readonly theme: 'dark' | 'light';
  readonly sidebarVisible: boolean;
  readonly onToggleSidebar: () => void;
  readonly onToggleTheme: () => void;
  readonly onNewConnection: () => void;
  readonly onNewQuery: () => void;
  readonly newQueryDisabled: boolean;
  readonly onCreateTable: () => void;
  readonly createTableDisabled: boolean;
  readonly historyOpen: boolean;
  readonly onToggleHistory: () => void;
  readonly onSchedules: () => void;
  readonly jobsOpen: boolean;
  readonly jobsRunning: number;
  readonly onToggleJobs: () => void;
}) {
  const platform = useWindowState((s) => s.platform);
  const mac = platform === 'darwin';
  const fullScreen = useWindowState((s) => s.fullScreen);
  const quickOpenBinding = useBindingOf('workbench.quickOpen');
  const commandBinding = useBindingOf('workbench.commandPalette');
  const quickOpenKeys = quickOpenBinding ? bindingLabel(quickOpenBinding, mac) : 'no keys';
  const commandKeys = commandBinding ? bindingLabel(commandBinding, mac) : 'no keys';
  return (
    <header
      className="flex shrink-0 flex-col border-b border-border bg-panel text-muted select-none [-webkit-app-region:drag]"
      data-testid="title-bar"
    >
      <div
        className="relative flex h-[35px] shrink-0 items-center"
        style={{
          paddingLeft: mac && !fullScreen ? 78 : 8,
          // The overlaid window controls (Windows, Linux) take the rest of the bar's width.
          paddingRight:
            'calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw) + 6px)',
        }}
      >
        <div className="pointer-events-none absolute inset-x-0 flex justify-center px-[260px]">
          {props.production !== undefined ? (
            <span
              role="status"
              data-testid="production-banner"
              className="truncate rounded-sm bg-env-production px-2 py-0.5 text-[11px] font-bold tracking-wide text-accent-fg uppercase"
            >
              Production · {props.production}
            </span>
          ) : (
            // VS Code's command center: the active tab's title in a search box that opens Go to
            // Object (and with ">" the commands).
            <button
              type="button"
              data-testid="command-center"
              aria-label="Search tables, collections and commands"
              title={`Go to a table or collection (${quickOpenKeys}), run a command (${commandKeys})`}
              onClick={() => openPalette('')}
              className="pointer-events-auto flex h-[22px] w-full max-w-[460px] items-center justify-center gap-2 rounded-md border border-border bg-deep/60 px-3 text-xs text-muted hover:border-strong hover:bg-hover hover:text-fg [-webkit-app-region:no-drag]"
            >
              <Icon name="search" className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate" data-testid="window-title">
                {props.title ?? 'Querybara'}
              </span>
            </button>
          )}
        </div>
        {!mac && <WindowMenuBar platform={platform} />}
      </div>

      <div
        className="flex h-[60px] shrink-0 items-center gap-1 px-2 pb-1"
        role="toolbar"
        aria-label="Window"
      >
        <ToolButton
          label="New connection"
          text="Connection"
          icon="connection-new"
          tone="text-celadon"
          onClick={props.onNewConnection}
        />
        {/* In the accent: the window's first action once a connection is open. */}
        <ToolButton
          label="New query"
          text="New Query"
          icon="query"
          tone="text-rust"
          onClick={props.onNewQuery}
          disabled={props.newQueryDisabled}
        />
        <ToolButton
          label="Create table"
          tooltip="Create a table"
          text="Table"
          icon="table-new"
          tone="text-cobalt"
          onClick={props.onCreateTable}
          disabled={props.createTableDisabled}
        />
        <Divider />
        <ToolButton
          label="History"
          tooltip={props.historyOpen ? 'Hide the history' : 'Show the history'}
          text="History"
          icon="history"
          tone="text-lilac"
          pressed={props.historyOpen}
          onClick={props.onToggleHistory}
        />
        <SyncMenu
          trigger={
            <button
              type="button"
              aria-label="Compare"
              title="Compare structure or data"
              className={TOOL}
            >
              <ToolFace text="Compare" icon="compare" tone="text-teal" />
            </button>
          }
        />
        <ToolButton
          label="Schedules"
          text="Schedules"
          icon="schedule"
          tone="text-ochre"
          onClick={props.onSchedules}
        />
        <ToolButton
          label="Jobs"
          tooltip={props.jobsOpen ? 'Hide the jobs' : 'Show the jobs'}
          text="Jobs"
          icon="jobs"
          tone="text-peach"
          pressed={props.jobsOpen}
          onClick={props.onToggleJobs}
          badge={
            props.jobsRunning > 0 ? (
              <span
                className="absolute top-0.5 left-[calc(50%+8px)] min-w-3.5 rounded-full bg-accent px-0.5 text-center text-[9px] leading-3.5 font-semibold text-accent-fg ring-2 ring-panel"
                aria-label={`${props.jobsRunning} running`}
              >
                {props.jobsRunning}
              </span>
            ) : undefined
          }
        />
        <span className="flex-1" />
        {/* Navicat's View: the switches in one pill, named under it. */}
        <div className="flex flex-col items-center gap-1 px-1 [-webkit-app-region:no-drag]">
          <div className="flex h-[30px] items-center rounded-md border border-border bg-deep p-px">
            <PillButton
              label="Side bar"
              tooltip={props.sidebarVisible ? 'Hide the side bar' : 'Show the side bar'}
              icon="sidebar"
              pressed={props.sidebarVisible}
              onClick={props.onToggleSidebar}
            />
            <span aria-hidden="true" className="mx-px h-3.5 w-px bg-border" />
            <PillButton
              label="Switch theme"
              tooltip={
                props.theme === 'dark' ? 'Switch to Bisque (light)' : 'Switch to Tenmoku (dark)'
              }
              icon={props.theme === 'dark' ? 'sun' : 'moon'}
              onClick={props.onToggleTheme}
            />
          </div>
          <span aria-hidden="true" className="text-[11px] leading-none">
            View
          </span>
        </div>
      </div>
    </header>
  );
}

type IconName = Parameters<typeof Icon>[0]['name'];

/** A tool: its tile and name stacked, a raised card when hovered, the accent's when pressed. */
const TOOL = cx(
  'group relative flex h-[54px] min-w-[60px] flex-col items-center justify-center gap-1 rounded-md border border-transparent px-1.5 outline-none [-webkit-app-region:no-drag]',
  'transition-[background-color,border-color] duration-100',
  'hover:border-border hover:bg-list-hover active:bg-pressed',
  'focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1 focus-visible:outline-focus',
  'aria-pressed:border-accent/60 aria-pressed:bg-list-active',
  'data-[state=open]:border-accent/60 data-[state=open]:bg-list-active',
  'disabled:opacity-40 disabled:hover:border-transparent disabled:hover:bg-transparent',
);

/** The tile (the engine cards' pictogram square, smaller) and the name under it. */
function ToolFace(props: {
  readonly text: string;
  readonly icon: IconName;
  readonly tone: string;
}) {
  return (
    <>
      <span
        aria-hidden="true"
        className={cx(
          'flex h-[30px] w-[30px] items-center justify-center rounded-md bg-current/12 ring-1 ring-current/20 ring-inset',
          'transition-[background-color] duration-100 group-hover:bg-current/18 group-aria-pressed:bg-current/22',
          props.tone,
        )}
      >
        <Icon name={props.icon} className="h-[18px] w-[18px]" />
      </span>
      <span
        aria-hidden="true"
        className="text-[11px] leading-none whitespace-nowrap text-muted group-hover:text-fg group-aria-pressed:text-fg group-data-[state=open]:text-fg"
      >
        {props.text}
      </span>
    </>
  );
}

function ToolButton(props: {
  /** The accessible name; `text`, the name shown, is a part of it. */
  readonly label: string;
  readonly text: string;
  readonly tooltip?: string;
  readonly icon: IconName;
  /** The tile's glaze, as a text colour class. */
  readonly tone: string;
  readonly onClick: () => void;
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  readonly badge?: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.tooltip ?? props.label}
      aria-pressed={props.pressed}
      disabled={props.disabled}
      onClick={props.onClick}
      className={TOOL}
    >
      <ToolFace text={props.text} icon={props.icon} tone={props.tone} />
      {props.badge}
    </button>
  );
}

function PillButton(props: {
  readonly label: string;
  readonly tooltip: string;
  readonly icon: IconName;
  readonly onClick: () => void;
  readonly pressed?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.tooltip}
      aria-pressed={props.pressed}
      onClick={props.onClick}
      className="flex h-[26px] w-[32px] items-center justify-center rounded-sm text-muted outline-none hover:bg-hover hover:text-fg focus-visible:outline focus-visible:outline-1 focus-visible:outline-focus active:bg-pressed aria-pressed:bg-list-active aria-pressed:text-accent"
    >
      <Icon name={props.icon} />
    </button>
  );
}

function Divider() {
  return <span aria-hidden="true" className="mx-1 h-8 w-px shrink-0 bg-border" />;
}
