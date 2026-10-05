import { describe, expect, it } from 'vitest';

import {
  endpointLabel,
  exportSummary,
  folderPathsById,
  importKeys,
  importSummary,
} from '../src/renderer/src/state/connection-files';

/** The wording and choices the Import and Export connections dialogs share. */

const entry = (key: string, existing?: string) => ({
  key,
  ...(existing ? { existing: { id: existing, name: existing } } : {}),
});

describe('connection files', () => {
  it('imports the ticked entries, and those that exist only when replacing', () => {
    const preview = { entries: [entry('a'), entry('b', 'B'), entry('c')] } as never;
    expect(importKeys(preview, new Set(['a', 'b']), false)).toEqual(['a']);
    expect(importKeys(preview, new Set(['a', 'b']), true)).toEqual(['a', 'b']);
    expect(importKeys(preview, new Set(), true)).toEqual([]);
  });

  it('describes endpoints', () => {
    expect(endpointLabel({ endpoint: { kind: 'host', host: 'db', port: 5432 } })).toBe('db:5432');
    expect(endpointLabel({ endpoint: { kind: 'host', host: '::1', port: 6379 } })).toBe(
      '[::1]:6379',
    );
    expect(endpointLabel({ endpoint: { kind: 'socket', path: '/tmp/mysql.sock' } })).toBe(
      '/tmp/mysql.sock',
    );
    expect(
      endpointLabel({
        endpoint: { kind: 'sentinel', masterName: 'main', sentinels: [{ host: 's', port: 26379 }] },
      }),
    ).toBe('main via s:26379');
  });

  it('summarises an import and an export', () => {
    expect(
      importSummary({
        added: 2,
        replaced: 1,
        skipped: 1,
        savedLogins: 1,
        unsavedLogins: 2,
        profileIds: [],
      }),
    ).toBe(
      'Imported 3 connections (1 replaced), 1 password saved. 1 connection already existed. 2 passwords could not be saved without a keychain; you are asked when connecting.',
    );
    expect(
      importSummary({
        added: 1,
        replaced: 0,
        skipped: 0,
        savedLogins: 0,
        unsavedLogins: 0,
        profileIds: [],
      }),
    ).toBe('Imported 1 connection.');
    expect(exportSummary({ profiles: 4, logins: 3, unreadable: 1 }, true)).toBe(
      'Exported 4 connections with 3 passwords. 1 saved password could not be read here and was left out.',
    );
    expect(exportSummary({ profiles: 1, logins: 0, unreadable: 0 }, false)).toBe(
      'Exported 1 connection.',
    );
  });

  it('names folders by their path, even in a cycle', () => {
    const paths = folderPathsById([
      { id: 'c', parentId: 'b', name: 'Prod' },
      { id: 'a', parentId: null, name: 'Shop' },
      { id: 'b', parentId: 'a', name: 'EU' },
      { id: 'x', parentId: 'y', name: 'X' },
      { id: 'y', parentId: 'x', name: 'Y' },
    ]);
    expect(paths.get('c')).toBe('Shop / EU / Prod');
    expect(paths.get('a')).toBe('Shop');
    expect(paths.get('x')).toBe('Y / X');
  });
});
