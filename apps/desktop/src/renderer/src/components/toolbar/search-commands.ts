import type { StoredProfile } from '@querybara/ipc';

import { registerCommands } from '../../state/commands';
import { connectedProfiles, resolveProfile } from '../../state/connection-context';
import { loadChildren, pathKey, useExplorer } from '../../state/explorer';
import { quickPick } from '../../state/palette';
import { openCreateIndex } from '../../state/search/create-index';
import { DocumentsView } from '../../state/search/documents';
import { searchObjectOf } from '../../state/search/explorer';
import { IndexView } from '../../state/search/index-view';
import { getSearchPanel } from '../../state/search/panels';
import { useWorkspace } from '../../state/workspace';
import { openSearchConsole, openSearchTool } from '../search/open';

/**
 * The Elasticsearch toolbar's commands (ADR 0042): the console, documents, an index and its
 * creation, SQL, the cluster, templates and pipelines, and snapshots, on the connection in
 * front. Documents and Index work on the index (alias or data stream) of the Elasticsearch tab
 * in front, and ask for one otherwise.
 */

const isSearch = (profile: StoredProfile): boolean => profile.engine === 'elasticsearch';

const anySearch = (): boolean => connectedProfiles(isSearch).length > 0;

type Target = { readonly name: string; readonly kind: 'index' | 'alias' | 'data-stream' };

function resolveSearchProfile(): Promise<StoredProfile | undefined> {
  return resolveProfile(isSearch, 'Which Elasticsearch connection?');
}

/** The index, alias or data stream of the active tab, when it is this connection's. */
function activeTarget(profileId: string): Target | undefined {
  const id = useWorkspace.getState().activeTabId;
  const panel = id === undefined ? undefined : getSearchPanel(id);
  if (panel instanceof DocumentsView && panel.target.profileId === profileId) {
    return { name: panel.target.target, kind: panel.target.kind };
  }
  if (panel instanceof IndexView && panel.target.profileId === profileId) {
    return { name: panel.target.index, kind: 'index' };
  }
  return undefined;
}

const FOLDERS = ['indices', 'aliases', 'data-streams'] as const;

/** The target in front, else one picked from the connection's indices (and, with `all`, more). */
async function pickTarget(
  profile: StoredProfile,
  options: { readonly indicesOnly?: boolean } = {},
): Promise<Target | undefined> {
  const inFront = activeTarget(profile.id);
  if (inFront && (!options.indicesOnly || inFront.kind === 'index')) return inFront;
  const folders = options.indicesOnly ? (['indices'] as const) : FOLDERS;
  const lists = await Promise.all(
    folders.map(async (folder) => {
      await loadChildren(profile.id, [folder]).catch(() => undefined);
      const nodes = useExplorer.getState().children[profile.id]?.[pathKey([folder])]?.nodes ?? [];
      return nodes.flatMap((node) => {
        const object = searchObjectOf(node);
        return object ? [{ name: object.name, kind: object.kind }] : [];
      });
    }),
  );
  return quickPick({
    placeholder: `Which ${options.indicesOnly ? 'index' : 'index, alias or data stream'} of ${profile.name}?`,
    items: lists.flat().map((target) => ({
      label: target.name,
      description: target.kind === 'index' ? undefined : target.kind.replace('-', ' '),
      icon: 'table' as const,
      value: target,
    })),
  });
}

export function registerSearchCommands(): () => void {
  return registerCommands([
    {
      id: 'search.console',
      category: 'Elasticsearch',
      title: 'Open Console',
      icon: 'shell',
      keywords: ['query', 'dsl', 'request', 'kibana'],
      enabled: anySearch,
      run: async () => {
        const profile = await resolveSearchProfile();
        if (profile) openSearchConsole({ profileId: profile.id, title: `${profile.name} console` });
      },
    },
    {
      id: 'search.documents',
      category: 'Elasticsearch',
      title: 'Browse Documents…',
      icon: 'table',
      keywords: ['documents', 'hits', 'search'],
      enabled: anySearch,
      run: async () => {
        const profile = await resolveSearchProfile();
        const target = profile && (await pickTarget(profile));
        if (!profile || !target) return;
        openSearchTool({
          tool: 'documents',
          target: { profileId: profile.id, target: target.name, kind: target.kind },
        });
      },
    },
    {
      id: 'search.sql',
      category: 'Elasticsearch',
      title: 'Open SQL',
      icon: 'query',
      keywords: ['sql', 'select', 'translate'],
      enabled: anySearch,
      run: async () => {
        const profile = await resolveSearchProfile();
        if (profile) openSearchTool({ tool: 'sql', profileId: profile.id });
      },
    },
    {
      id: 'search.index',
      category: 'Elasticsearch',
      title: 'Open Index…',
      icon: 'settings',
      keywords: ['mappings', 'settings', 'aliases', 'index'],
      enabled: anySearch,
      run: async () => {
        const profile = await resolveSearchProfile();
        const target = profile && (await pickTarget(profile, { indicesOnly: true }));
        if (!profile || !target) return;
        openSearchTool({ tool: 'index', profileId: profile.id, index: target.name });
      },
    },
    {
      id: 'search.createIndex',
      category: 'Elasticsearch',
      title: 'Create Index…',
      icon: 'table-new',
      keywords: ['new', 'index', 'mapping'],
      enabled: () => connectedProfiles((p) => isSearch(p) && !p.presentation.readOnly).length > 0,
      run: async () => {
        const profile = await resolveProfile(
          (p) => isSearch(p) && !p.presentation.readOnly,
          'Which Elasticsearch connection?',
        );
        if (profile) openCreateIndex(profile.id);
      },
    },
    {
      id: 'search.cluster',
      category: 'Elasticsearch',
      title: 'Cluster',
      icon: 'server',
      keywords: ['nodes', 'shards', 'health', 'allocation'],
      enabled: anySearch,
      run: async () => {
        const profile = await resolveSearchProfile();
        if (profile) openSearchTool({ tool: 'cluster', profileId: profile.id });
      },
    },
    {
      id: 'search.templates',
      category: 'Elasticsearch',
      title: 'Templates and Pipelines',
      icon: 'design',
      keywords: ['index templates', 'ingest', 'pipelines', 'ilm'],
      enabled: anySearch,
      run: async () => {
        const profile = await resolveSearchProfile();
        if (profile) openSearchTool({ tool: 'admin', profileId: profile.id });
      },
    },
    {
      id: 'search.snapshots',
      category: 'Elasticsearch',
      title: 'Snapshots',
      icon: 'archive',
      keywords: ['backup', 'restore', 'repository'],
      enabled: anySearch,
      run: async () => {
        const profile = await resolveSearchProfile();
        if (profile) openSearchTool({ tool: 'snapshots', profileId: profile.id });
      },
    },
  ]);
}
