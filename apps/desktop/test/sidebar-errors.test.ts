import { QuerybaraError, type BrowseNode } from '@querybara/core';
import type { StoredProfile } from '@querybara/ipc';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { keys, queryClient } from '../src/renderer/src/state/data';
import {
  loadChildren,
  pathKey,
  resetExplorer,
  toggleNode,
  useExplorer,
} from '../src/renderer/src/state/explorer';
import { dismissToast, toastError, useToasts } from '../src/renderer/src/state/toasts';

/**
 * The side bar's errors show as toasts, not in the tree: a node that fails to load folds back
 * and says why in a toast, and a node the session cannot browse does not open at all.
 */

const host = vi.hoisted(() => ({ browse: vi.fn() }));
vi.mock('../src/renderer/src/state/connections', () => ({
  connect: () =>
    Promise.resolve({
      generation: 1,
      host: { openSession: () => Promise.resolve({ sessionId: 's1' }), browse: host.browse },
    }),
}));

const toasts = () => useToasts.getState().toasts;

beforeEach(() => useToasts.setState({ toasts: [] }));

describe('toasts', () => {
  it('replaces the same message rather than stacking a copy', () => {
    toastError('boom', { title: 'Knowly' });
    const first = toasts()[0]!.id;
    toastError('boom', { title: 'Knowly' });
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]!.id).not.toBe(first);
    toastError('boom', { title: 'Other' });
    expect(toasts()).toHaveLength(2);
  });

  it('keeps the newest few', () => {
    for (let i = 1; i <= 6; i++) toastError(`error ${i}`);
    expect(toasts().map((t) => t.message)).toEqual(['error 3', 'error 4', 'error 5', 'error 6']);
  });

  it('dismisses one by its id', () => {
    toastError('one');
    toastError('two');
    dismissToast(toasts()[0]!.id);
    expect(toasts().map((t) => t.message)).toEqual(['two']);
  });
});

describe('the explorer', () => {
  const PROFILE = 'p1';
  const database: BrowseNode = {
    kind: 'database',
    name: 'postgres',
    path: ['postgres'],
    hasChildren: true,
  };
  const key = pathKey(database.path);

  beforeEach(() => {
    resetExplorer(PROFILE);
    host.browse.mockReset();
    queryClient.setQueryData(keys.profiles, [
      { id: PROFILE, name: 'Knowly' } as unknown as StoredProfile,
    ]);
  });

  it('folds an open node that fails back, and shows why in a toast', async () => {
    host.browse.mockRejectedValue(new QuerybaraError({ code: 'NOT_SUPPORTED', message: 'boom' }));
    toggleNode(PROFILE, database);
    expect(useExplorer.getState().expanded[PROFILE]?.[key]).toBe(true);
    await vi.waitFor(() => expect(toasts()).toHaveLength(1));
    expect(toasts()[0]).toMatchObject({ title: 'Knowly', message: 'boom' });
    expect(useExplorer.getState().expanded[PROFILE]?.[key]).toBe(false);
    // The Objects view still shows it in place.
    expect(useExplorer.getState().children[PROFILE]?.[key]?.error).toBe('boom');
  });

  it('leaves the error of a folded node to the Objects view', async () => {
    host.browse.mockRejectedValue(new Error('boom'));
    await loadChildren(PROFILE, database.path);
    expect(toasts()).toEqual([]);
    expect(useExplorer.getState().children[PROFILE]?.[key]?.error).toBe('boom');
  });

  it('does not open a node the session cannot browse', () => {
    toggleNode(PROFILE, { ...database, unavailable: 'Connected to another database' });
    expect(useExplorer.getState().expanded[PROFILE]?.[key]).toBeUndefined();
    expect(host.browse).not.toHaveBeenCalled();
  });
});
