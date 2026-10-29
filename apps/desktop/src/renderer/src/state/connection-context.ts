import type { StoredProfile } from '@querybara/ipc';
import { useShallow } from 'zustand/react/shallow';

import { useConnections } from './connections';
import { keys, queryClient, useProfiles } from './data';
import { useObjectsView } from './objects-location';
import { quickPick } from './palette';
import { usePanels } from './panels';
import { useWorkspace } from './workspace';

/**
 * The connection in front (ADR 0042): what the toolbar shows the tools of, and what the engines'
 * toolbar commands act on. It is the active tab's connection, else the connection of the node
 * last picked in the side bar, else the connection last in front (while it stays open), else the
 * only open one. The engines' contexts (state/sql-context.ts, state/mongo/context.ts…) add the
 * database, schema or object from the same places.
 */

function profiles(): StoredProfile[] {
  return queryClient.getQueryData<StoredProfile[]>(keys.profiles) ?? [];
}

function isReady(profileId: string): boolean {
  return useConnections.getState().byProfile[profileId]?.status === 'ready';
}

/** The open connections, those `accepts` takes when given. */
export function connectedProfiles(accepts?: (profile: StoredProfile) => boolean): StoredProfile[] {
  return profiles().filter(
    (profile) => isReady(profile.id) && (accepts === undefined || accepts(profile)),
  );
}

/** The connection last found in front, kept while it stays open. */
let lastFocused: string | undefined;

/** The active tab's connection, if it has one ("" marks a panel of no connection). */
function activeTabProfile(): string | undefined {
  const id = useWorkspace.getState().activeTabId;
  if (id === undefined) return undefined;
  const fromTab = useWorkspace.getState().tabs[id]?.profileId;
  const fromPanel = usePanels.getState().panels[id]?.profileId;
  return fromTab || fromPanel || undefined;
}

/** The connection in front now: the active tab's, else the side bar's; undefined for neither. */
export function focusedProfileId(): string | undefined {
  const fromTab = activeTabProfile();
  const fromTree = useObjectsView.getState().location?.profileId;
  const focused = [fromTab, fromTree].find((id) => id !== undefined && isReady(id));
  if (focused !== undefined) lastFocused = focused;
  return focused;
}

/**
 * The connection the toolbar shows: the one in front, else the one last in front while it
 * stays open, else the first open one; undefined when none is open.
 */
export function toolbarProfileId(): string | undefined {
  const focused = focusedProfileId();
  if (focused !== undefined) return focused;
  if (lastFocused !== undefined && isReady(lastFocused)) return lastFocused;
  return connectedProfiles()[0]?.id;
}

/**
 * The connection a command acts on among those `accepts` takes: the one in front, else the one
 * last in front, else the only one open; asks when several are open and none is in front.
 */
export async function resolveProfile(
  accepts: (profile: StoredProfile) => boolean,
  placeholder: string,
): Promise<StoredProfile | undefined> {
  const candidates = connectedProfiles(accepts);
  const focused = focusedProfileId() ?? lastFocused;
  const inFront = candidates.find((profile) => profile.id === focused);
  if (inFront) return inFront;
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) return undefined;
  return quickPick({
    placeholder,
    items: candidates.map((profile) => ({
      label: profile.name,
      description: profile.presentation.environment,
      icon: 'plug' as const,
      value: profile,
    })),
  });
}

/** The connection the toolbar shows, kept current as tabs, the side bar and connections change. */
export function useToolbarProfile(): StoredProfile | undefined {
  const list = useProfiles();
  // Each store the choice reads, so a change in any re-renders the toolbar.
  useWorkspace((state) => state.activeTabId);
  usePanels((state) => state.panels);
  useObjectsView((state) => state.location?.profileId);
  useConnections(
    useShallow((state) =>
      Object.values(state.byProfile)
        .filter((connection) => connection.status === 'ready')
        .map((connection) => connection.profileId),
    ),
  );
  const id = toolbarProfileId();
  return id === undefined ? undefined : list.data?.find((profile) => profile.id === id);
}

/** Forgets the connection last in front (tests). */
export function resetConnectionContext(): void {
  lastFocused = undefined;
}
