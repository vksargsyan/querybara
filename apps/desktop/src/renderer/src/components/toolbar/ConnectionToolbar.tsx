import { ENGINES } from '@querybara/core';
import { Fragment } from 'react';

import { bindingLabel } from '../../lib/keys';
import { commandById, isEnabled, runCommand, useCommands } from '../../state/commands';
import { useToolbarProfile } from '../../state/connection-context';
import { effectiveBindings, useKeybindings } from '../../state/keybindings';
import { useToolbar } from '../../state/toolbar';
import { useWindowState } from '../../state/window';
import { Icon, cx } from '../ui';
import { TOOLBARS, toolbarKind, type ToolTone } from './tools';

/** Each glaze as a literal class, so Tailwind finds it. */
const TONES: Readonly<Record<ToolTone, string>> = {
  rust: 'text-rust',
  cobalt: 'text-cobalt',
  celadon: 'text-celadon',
  ochre: 'text-ochre',
  lilac: 'text-lilac',
  peach: 'text-peach',
  teal: 'text-teal',
};

/**
 * The connection toolbar (ADR 0042, ADR 0043) under the title bar: Studio 3T's row of tools
 * (ADR 0036), for every engine. It shows the tools of the connection in front (the active tab's,
 * else the side bar's, else the one last in front), so it changes as you move between a
 * PostgreSQL tab and a MongoDB one; each button is a command acting on what is in front, asking
 * for what is not. The buttons are all one width, their icons in a glaze each, in groups with a
 * small label above. It shows while a connection is open; Ctrl+Alt+B (View › Toggle Toolbar)
 * hides it.
 */
export function ConnectionToolbar() {
  const visible = useToolbar((s) => s.visible);
  const profile = useToolbarProfile();
  // Re-render when commands register (their enabled state is read below).
  useCommands((s) => s.version);
  const overrides = useKeybindings((s) => s.overrides);
  const mac = useWindowState((s) => s.platform) === 'darwin';
  if (!visible || !profile) return null;
  const bindings = effectiveBindings(overrides);
  const engine = ENGINES[profile.engine].displayName;
  return (
    <div
      role="toolbar"
      aria-label={engine}
      data-testid="connection-toolbar"
      data-engine={profile.engine}
      className="flex shrink-0 items-stretch overflow-x-auto border-b border-border bg-panel px-2 pt-1 pb-0.5"
    >
      {TOOLBARS[toolbarKind(profile.engine)].map((group, index) => (
        <Fragment key={group.label}>
          {index > 0 && <span className="mx-1.5 my-1 w-px shrink-0 bg-border" aria-hidden="true" />}
          <div
            role="group"
            aria-label={group.label}
            data-testid="toolbar-group"
            className="flex shrink-0 flex-col items-center"
          >
            <span
              aria-hidden="true"
              className="text-[9px] leading-3 font-semibold tracking-wider whitespace-nowrap text-faint uppercase"
            >
              {group.label}
            </span>
            <div className="flex gap-0.5">
              {group.tools.map((tool) => {
                const command = commandById(tool.command);
                const enabled = command !== undefined && isEnabled(command);
                const binding = bindings.get(tool.command);
                const keys = binding ? ` (${bindingLabel(binding, mac)})` : '';
                return (
                  <button
                    key={tool.command}
                    type="button"
                    disabled={!enabled}
                    title={`${command?.title ?? tool.label}${keys}`}
                    onClick={() => void runCommand(tool.command)}
                    className={cx(
                      'flex w-[72px] flex-col items-center justify-center gap-0.5 rounded-sm px-1 py-0.5 text-[11px] text-muted',
                      'hover:bg-hover hover:text-fg active:bg-pressed disabled:opacity-40 disabled:hover:bg-transparent',
                    )}
                  >
                    <Icon name={tool.icon} className={cx('h-4 w-4', TONES[tool.tone])} />
                    <span className="max-w-full truncate">{tool.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </Fragment>
      ))}
    </div>
  );
}
