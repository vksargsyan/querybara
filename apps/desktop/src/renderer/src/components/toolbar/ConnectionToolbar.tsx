import { ENGINES } from '@querybara/core';

import { bindingLabel } from '../../lib/keys';
import { commandById, isEnabled, runCommand, useCommands } from '../../state/commands';
import { useToolbarProfile } from '../../state/connection-context';
import { effectiveBindings, useKeybindings } from '../../state/keybindings';
import { useToolbar } from '../../state/toolbar';
import { useWindowState } from '../../state/window';
import { Icon, cx } from '../ui';
import { TOOLBARS, toolbarKind } from './tools';

/**
 * The connection toolbar (ADR 0042) under the title bar: Studio 3T's row of tools (ADR 0036),
 * for every engine. It shows the tools of the connection in front (the active tab's, else the
 * side bar's, else the one last in front), so it changes as you move between a PostgreSQL tab
 * and a MongoDB one; each button is a command acting on what is in front, asking for what is
 * not. It shows while a connection is open; Ctrl+Alt+B (View › Toggle Toolbar) hides it.
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
      className="flex shrink-0 items-stretch gap-0.5 overflow-x-auto border-b border-border bg-panel px-2 py-0.5"
    >
      {TOOLBARS[toolbarKind(profile.engine)].map((group, index) => (
        <div key={index} className="flex items-stretch gap-0.5">
          {index > 0 && <span className="mx-1 my-1.5 w-px bg-border" aria-hidden="true" />}
          {group.map((tool) => {
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
                  'flex min-w-[52px] flex-col items-center justify-center gap-0.5 rounded-sm px-1.5 py-0.5 text-[11px] text-muted',
                  'hover:bg-hover hover:text-fg active:bg-pressed disabled:opacity-40 disabled:hover:bg-transparent',
                )}
              >
                <Icon name={tool.icon} className="h-4 w-4" />
                <span className="whitespace-nowrap">{tool.label}</span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
