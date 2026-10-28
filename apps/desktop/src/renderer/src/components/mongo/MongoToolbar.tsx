import { useShallow } from 'zustand/react/shallow';

import { bindingLabel } from '../../lib/keys';
import { commandById, isEnabled, runCommand, useCommands } from '../../state/commands';
import { useConnections } from '../../state/connections';
import { useProfiles } from '../../state/data';
import { useKeybindings, effectiveBindings } from '../../state/keybindings';
import { useWindowState } from '../../state/window';
import { Icon, cx, type IconName } from '../ui';
import { useMongoToolbar } from './mongo-commands';

/**
 * The MongoDB toolbar (ADR 0036), Studio 3T's row of tools under the title bar: Connect,
 * Collection, IntelliShell, SQL, Aggregate, Query Profiler, Export, Import, Compare, Schema,
 * Reschema, Masking, Transfer, Users,
 * Roles, Server Status and Tasks, each a command acting on the connection, database and
 * collection in view (asking when none is). It shows while a MongoDB connection is open;
 * Ctrl+Alt+B (View › Toggle MongoDB Toolbar) hides it.
 */

interface Tool {
  readonly command: string;
  readonly label: string;
  readonly icon: IconName;
}

const GROUPS: readonly (readonly Tool[])[] = [
  [{ command: 'connection.new', label: 'Connect', icon: 'connection-new' }],
  [
    { command: 'mongo.openCollection', label: 'Collection', icon: 'table' },
    { command: 'mongo.openIntelliShell', label: 'IntelliShell', icon: 'shell' },
    { command: 'mongo.openSql', label: 'SQL', icon: 'query' },
    { command: 'mongo.openAggregation', label: 'Aggregate', icon: 'filter' },
    { command: 'mongo.profiler', label: 'Query Profiler', icon: 'history' },
  ],
  [
    { command: 'mongo.export', label: 'Export', icon: 'export' },
    { command: 'mongo.import', label: 'Import', icon: 'import' },
  ],
  [
    { command: 'mongo.compare', label: 'Compare', icon: 'compare' },
    { command: 'mongo.analyzeSchema', label: 'Schema', icon: 'chart' },
    { command: 'mongo.reschema', label: 'Reschema', icon: 'design' },
    { command: 'mongo.mask', label: 'Masking', icon: 'eye-off' },
    { command: 'mongo.transfer', label: 'Transfer', icon: 'transfer' },
    { command: 'tools.schedules', label: 'Tasks', icon: 'schedule' },
  ],
  [
    { command: 'mongo.manageUsers', label: 'Users', icon: 'users' },
    { command: 'mongo.manageRoles', label: 'Roles', icon: 'key' },
    { command: 'mongo.serverStatus', label: 'Server Status', icon: 'gauge' },
  ],
];

export function MongoToolbar() {
  const visible = useMongoToolbar((s) => s.visible);
  const profiles = useProfiles();
  const ready = useConnections(
    useShallow((state) =>
      Object.values(state.byProfile)
        .filter((connection) => connection.status === 'ready')
        .map((connection) => connection.profileId),
    ),
  );
  // Re-render when commands register (their enabled state is read below).
  useCommands((s) => s.version);
  const overrides = useKeybindings((s) => s.overrides);
  const mac = useWindowState((s) => s.platform) === 'darwin';
  const mongo = (profiles.data ?? []).some(
    (profile) => profile.engine === 'mongodb' && ready.includes(profile.id),
  );
  if (!visible || !mongo) return null;
  const bindings = effectiveBindings(overrides);
  return (
    <div
      role="toolbar"
      aria-label="MongoDB"
      data-testid="mongo-toolbar"
      className="flex shrink-0 items-stretch gap-0.5 overflow-x-auto border-b border-border bg-panel px-2 py-0.5"
    >
      {GROUPS.map((group, index) => (
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
