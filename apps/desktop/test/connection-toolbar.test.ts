import { connectionProfileSchema, type EngineId } from '@querybara/core';
import type { StoredProfile } from '@querybara/ipc';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { TOOLBARS, toolbarKind } from '../src/renderer/src/components/toolbar/tools';
import type { HostClient } from '../src/renderer/src/lib/main-client';
import {
  focusedProfileId,
  resetConnectionContext,
  resolveProfile,
  toolbarProfileId,
} from '../src/renderer/src/state/connection-context';
import { useConnections } from '../src/renderer/src/state/connections';
import { keys, queryClient } from '../src/renderer/src/state/data';
import { effectiveBindings } from '../src/renderer/src/state/keybindings';
import { useObjectsView } from '../src/renderer/src/state/objects-location';
import { sqlContextOf, sqlPlace } from '../src/renderer/src/state/sql-context';
import { useWorkspace, type QueryTab } from '../src/renderer/src/state/workspace';
import { profileInput } from './helpers';

/** The connection toolbar (ADR 0042): which engine's tools it shows, and what they act on. */

function profile(id: string, engine: EngineId, readOnly = false): StoredProfile {
  return {
    ...connectionProfileSchema.parse(
      profileInput({
        id,
        name: id,
        engine,
        endpoint:
          engine === 'elasticsearch'
            ? { kind: 'urls', urls: ['http://localhost:9200'] }
            : { kind: 'host', host: 'localhost', port: 1 },
        presentation: { readOnly },
      }),
    ),
    version: 1,
  };
}

function connect(...profiles: StoredProfile[]): void {
  queryClient.setQueryData(keys.profiles, profiles);
  useConnections.setState({
    byProfile: Object.fromEntries(
      profiles.map((p) => [
        p.id,
        {
          profileId: p.id,
          status: 'ready' as const,
          host: {} as HostClient,
          generation: 1,
          connectionId: `c-${p.id}`,
        },
      ]),
    ),
  });
}

function showTab(id: string, tab: Partial<QueryTab>): void {
  useWorkspace.setState({
    activeTabId: id,
    tabs: { [id]: { id, title: id, ...tab } as QueryTab },
  });
}

function pickInTree(profileId: string, source: string[]): void {
  useObjectsView.setState({ location: { profileId, path: source, trail: source, source } });
}

afterEach(() => {
  useWorkspace.setState({ activeTabId: undefined, tabs: {} });
  useObjectsView.setState({ location: undefined });
  useConnections.setState({ byProfile: {} });
  queryClient.clear();
  resetConnectionContext();
});

describe('the tools of each engine', () => {
  it('maps the SQL engines to one toolbar and the others to their own', () => {
    expect(toolbarKind('postgres')).toBe('sql');
    expect(toolbarKind('mysql')).toBe('sql');
    expect(toolbarKind('mariadb')).toBe('sql');
    expect(toolbarKind('mongodb')).toBe('mongodb');
    expect(toolbarKind('redis')).toBe('redis');
    expect(toolbarKind('elasticsearch')).toBe('elasticsearch');
  });

  it('has every button name a command the renderer registers', () => {
    // The command modules draw through the dock, so their ids are read from the source.
    const root = join(import.meta.dirname, '../src/renderer/src/components');
    const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((file) =>
      /commands\.ts$/.test(file),
    );
    const registered = new Set(
      files.flatMap((file) =>
        [...readFileSync(join(root, file), 'utf8').matchAll(/\bid: '([\w.]+)'/g)].map(
          (match) => match[1]!,
        ),
      ),
    );
    expect(registered.has('sql.erDiagram')).toBe(true);
    for (const [kind, groups] of Object.entries(TOOLBARS)) {
      for (const tool of groups.flat()) {
        expect(registered.has(tool.command), `${kind}: ${tool.command}`).toBe(true);
      }
    }
  });
});

describe('the connection in front', () => {
  const pg = profile('pg', 'postgres');
  const mongo = profile('mongo', 'mongodb');

  it('is the active tab’s, else the side bar’s, else the one last in front, else the first open', () => {
    connect(pg, mongo);
    expect(focusedProfileId()).toBeUndefined();
    expect(toolbarProfileId()).toBe('pg');
    pickInTree('mongo', ['shop']);
    expect(toolbarProfileId()).toBe('mongo');
    showTab('t1', { profileId: 'pg' });
    expect(toolbarProfileId()).toBe('pg');
    // With nothing in front, the toolbar keeps the connection last in front.
    useWorkspace.setState({ activeTabId: undefined, tabs: {} });
    useObjectsView.setState({ location: undefined });
    expect(focusedProfileId()).toBeUndefined();
    expect(toolbarProfileId()).toBe('pg');
    // …while it stays open.
    connect(mongo);
    expect(toolbarProfileId()).toBe('mongo');
  });

  it('acts on the connection in front of the engine, or the only one, or asks', async () => {
    connect(pg, mongo);
    showTab('t1', { profileId: 'pg' });
    expect(await resolveProfile((p) => p.engine === 'postgres', '?')).toMatchObject({ id: 'pg' });
    // A MongoDB command with a PostgreSQL tab in front: the only MongoDB connection.
    expect(await resolveProfile((p) => p.engine === 'mongodb', '?')).toMatchObject({
      id: 'mongo',
    });
    expect(await resolveProfile((p) => p.engine === 'redis', '?')).toBeUndefined();
  });

  it('keeps no connection that is no longer open', () => {
    connect(pg);
    showTab('t1', { profileId: 'pg' });
    expect(toolbarProfileId()).toBe('pg');
    connect();
    expect(toolbarProfileId()).toBeUndefined();
  });
});

describe('the SQL context', () => {
  it('reads the database, schema and table from an explorer path', () => {
    expect(sqlPlace(['shop', 'public', 'tables', 'orders'], 'postgres')).toEqual({
      database: 'shop',
      schema: 'public',
      table: 'orders',
    });
    expect(sqlPlace(['shop', 'public', 'views'], 'postgres')).toEqual({
      database: 'shop',
      schema: 'public',
    });
    expect(sqlPlace(['shop'], 'postgres')).toEqual({ database: 'shop' });
    expect(sqlPlace(['shop', 'tables', 'orders'], 'mysql')).toEqual({
      database: 'shop',
      schema: 'shop',
      table: 'orders',
    });
    expect(sqlPlace([], 'mariadb')).toEqual({});
  });

  it('takes a query tab’s database first, then the side bar’s pick', () => {
    const pg = profile('pg', 'postgres');
    const my = profile('my', 'mysql');
    connect(pg, my);
    pickInTree('pg', ['shop', 'sales', 'tables', 'orders']);
    expect(sqlContextOf(pg)).toMatchObject({
      dialect: 'postgres',
      database: 'shop',
      schema: 'sales',
      table: 'orders',
    });
    showTab('t1', { profileId: 'pg', database: 'archive' });
    expect(sqlContextOf(pg)).toMatchObject({ database: 'archive' });
    expect(sqlContextOf(pg)?.schema).toBeUndefined();
    // Another connection's tab or pick says nothing about this one.
    expect(sqlContextOf(my)).toEqual({ profile: my, dialect: 'mysql' });
    expect(sqlContextOf(profile('m', 'mongodb'))).toBeUndefined();
  });
});

describe('the toggle key', () => {
  it('moves a binding set for the MongoDB toolbar to the connection toolbar', () => {
    expect(effectiveBindings([]).get('view.toggleToolbar')).toBe('mod+alt+b');
    expect(
      effectiveBindings([{ command: 'view.toggleMongoToolbar', key: 'mod+shift+t' }]).get(
        'view.toggleToolbar',
      ),
    ).toBe('mod+shift+t');
  });
});
