import type { StoredProfile } from '@querybara/ipc';

import { openBackupDialog, openRestoreDialog } from '../../state/backup/dialogs';
import { registerCommands } from '../../state/commands';
import { connectedProfiles, resolveProfile } from '../../state/connection-context';
import { panelInfo } from '../../state/panels';
import { openDumpAnalysis } from '../../state/redis/dump';
import { openRedisPanel, TOOL_TITLES, type RedisTool } from '../../state/redis/panels';
import { openTransferFrom } from '../../state/transfer-db/api';
import { useWorkspace } from '../../state/workspace';
import type { IconName } from '../icon-names';

/**
 * The Redis toolbar's commands (ADR 0042): the tools of a Redis connection's Tools folder, plus
 * transfer, backup, restore and dump analysis, on the connection in front. The key browser and
 * the CLI open on the logical database of the Redis tab in front, database 0 otherwise.
 */

const isRedis = (profile: StoredProfile): boolean => profile.engine === 'redis';

const anyRedis = (): boolean => connectedProfiles(isRedis).length > 0;

/** The logical database of the active tab, when it is one of this connection's Redis tabs. */
function activeDatabase(profileId: string): number | undefined {
  const id = useWorkspace.getState().activeTabId;
  const info = id === undefined ? undefined : panelInfo(id);
  if (info?.kind !== 'redis' || info.profileId !== profileId) return undefined;
  const match = /^db(\d+)$/.exec(info.database ?? '');
  return match ? Number(match[1]) : undefined;
}

async function openTool(tool: RedisTool): Promise<void> {
  const profile = await resolveProfile(isRedis, 'Which Redis connection?');
  if (!profile) return;
  const database = tool === 'keys' || tool === 'cli' ? activeDatabase(profile.id) : undefined;
  openRedisPanel({
    profileId: profile.id,
    profileName: profile.name,
    tool,
    ...(database !== undefined ? { database } : {}),
  });
}

const TOOLS: readonly { tool: RedisTool; id: string; icon: IconName; keywords: string[] }[] = [
  { tool: 'keys', id: 'redis.keys', icon: 'key', keywords: ['browse', 'scan', 'keys'] },
  { tool: 'cli', id: 'redis.cli', icon: 'shell', keywords: ['console', 'command', 'redis-cli'] },
  {
    tool: 'pubsub',
    id: 'redis.pubsub',
    icon: 'link',
    keywords: ['publish', 'subscribe', 'channels'],
  },
  { tool: 'search', id: 'redis.search', icon: 'search', keywords: ['redisearch', 'ft', 'index'] },
  {
    tool: 'dashboard',
    id: 'redis.dashboard',
    icon: 'gauge',
    keywords: ['info', 'memory', 'stats'],
  },
  { tool: 'slowlog', id: 'redis.slowlog', icon: 'history', keywords: ['slow', 'log'] },
  { tool: 'clients', id: 'redis.clients', icon: 'plug', keywords: ['client list', 'connections'] },
  { tool: 'latency', id: 'redis.latency', icon: 'pulse', keywords: ['latency', 'doctor'] },
  { tool: 'monitor', id: 'redis.monitor', icon: 'server', keywords: ['monitor', 'commands'] },
  { tool: 'bigkeys', id: 'redis.bigkeys', icon: 'chart', keywords: ['memory', 'size', 'big'] },
  { tool: 'config', id: 'redis.config', icon: 'settings', keywords: ['config', 'settings'] },
  { tool: 'acl', id: 'redis.acl', icon: 'users', keywords: ['acl', 'users', 'permissions'] },
  {
    tool: 'topology',
    id: 'redis.topology',
    icon: 'diagram',
    keywords: ['cluster', 'replicas', 'sentinel'],
  },
];

export function registerRedisCommands(): () => void {
  return registerCommands([
    ...TOOLS.map(({ tool, id, icon, keywords }) => ({
      id,
      category: 'Redis',
      title: TOOL_TITLES[tool],
      icon,
      keywords,
      enabled: anyRedis,
      run: () => openTool(tool),
    })),
    {
      id: 'redis.transfer',
      category: 'Redis',
      title: 'Transfer Data To…',
      icon: 'transfer',
      keywords: ['copy', 'migrate', 'keys'],
      enabled: anyRedis,
      run: async () => {
        const profile = await resolveProfile(isRedis, 'Which Redis connection?');
        if (profile) openTransferFrom(profile);
      },
    },
    {
      id: 'redis.backup',
      category: 'Redis',
      title: 'Back Up Keys…',
      icon: 'archive',
      keywords: ['backup', 'dump', 'export'],
      enabled: anyRedis,
      run: async () => {
        const profile = await resolveProfile(isRedis, 'Which Redis connection?');
        if (profile) openBackupDialog(profile);
      },
    },
    {
      id: 'redis.restore',
      category: 'Redis',
      title: 'Restore Keys…',
      icon: 'restore',
      keywords: ['backup', 'load', 'import'],
      enabled: () => connectedProfiles((p) => isRedis(p) && !p.presentation.readOnly).length > 0,
      run: async () => {
        const profile = await resolveProfile(
          (p) => isRedis(p) && !p.presentation.readOnly,
          'Which Redis connection?',
        );
        if (profile) openRestoreDialog(profile);
      },
    },
    {
      id: 'redis.dumpAnalysis',
      category: 'Redis',
      title: 'Dump Analysis',
      icon: 'open',
      keywords: ['rdb', 'memory', 'offline'],
      // A dump file is read offline, from this server or any other.
      run: () => openDumpAnalysis(),
    },
  ]);
}
