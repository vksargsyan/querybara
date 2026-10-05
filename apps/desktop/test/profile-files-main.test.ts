import { createCipheriv } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageChannel } from 'node:worker_threads';

import {
  createClient,
  fromNodePort,
  mainContract,
  serve,
  type Client,
  type MainContract,
  type PortLike,
} from '@querybara/ipc';
import { openStore, type SecretSealer } from '@querybara/storage';
import { afterEach, describe, expect, it } from 'vitest';

import { createMainHandlers } from '../src/main/api';
import { ConnectionSupervisor } from '../src/main/supervisor';
import { fakeHosts, profileInput } from './helpers';

/**
 * Importing and exporting connections through the main contract: an encrypted Querybara export
 * round-trips between two stores, a Navicat file imports with its saved passwords, and neither
 * the passwords nor the passphrase ever travel back to the renderer.
 */

const SECRET = 'db-Pa55word-7d1e';
const NAVICAT_SECRET = 'navicat-Pa55-4c2b';
const PASSPHRASE = 'export passphrase 91af';

const sealer: SecretSealer = {
  id: 'test-xor',
  isAvailable: () => true,
  seal: (plain) => new TextEncoder().encode(plain).map((b) => b ^ 0x2a),
  unseal: (sealed) => new TextDecoder().decode(sealed.map((b) => b ^ 0x2a)),
};

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function setup() {
  const store = openStore(':memory:', { sealer });
  const hosts = fakeHosts(() => {});
  const dialogs: { open?: string; save?: string } = {};
  const handlers = createMainHandlers<string>(
    {
      store,
      supervisor: new ConnectionSupervisor<string>({ spawn: hosts.spawn }),
      spawnHost: hosts.spawn,
      createChannel: () => ({ local: 'l', remote: 'r' }),
      appInfo: () => ({
        name: 'Querybara',
        version: '0.1.0',
        platform: 'linux',
        arch: 'x64',
        versions: { node: '24' },
      }),
      openExternal: async () => {},
    },
    {
      sendPort: () => {},
      openFile: async () => dialogs.open ?? null,
      saveFile: async () => dialogs.save ?? null,
    },
  );
  const channel = new MessageChannel();
  serve(fromNodePort(channel.port2), mainContract, handlers);
  const received: unknown[] = [];
  const recorded: PortLike = fromNodePort(channel.port1);
  const renderer: PortLike = {
    ...recorded,
    onMessage: (listener) =>
      recorded.onMessage((data) => {
        received.push(data);
        listener(data);
      }),
  };
  const main: Client<MainContract['shape']> = createClient(renderer, mainContract);
  cleanups.push(() => {
    channel.port1.close();
    channel.port2.close();
    store.close();
  });
  const leaked = (): boolean => {
    const everything = JSON.stringify(received);
    return [SECRET, NAVICAT_SECRET, PASSPHRASE].some((value) => everything.includes(value));
  };
  return { store, main, dialogs, leaked };
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'querybara-profile-files-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function navicatPassword(plain: string): string {
  const cipher = createCipheriv(
    'aes-128-cbc',
    Buffer.from('libcckeylibcckey'),
    Buffer.from('libcciv libcciv '),
  );
  return Buffer.concat([cipher.update(plain), cipher.final()])
    .toString('hex')
    .toUpperCase();
}

describe('connection files in main', () => {
  it('exports to an encrypted file and imports it into another store', async () => {
    const dir = tempDir();
    const source = setup();
    const folder = await source.main.folders.save({ name: 'Shop', parentId: null, sortOrder: 0 });
    const passwordId = crypto.randomUUID();
    const profile = await source.main.profiles.save({
      profile: profileInput({
        name: 'Shop DB',
        auth: { method: 'password', user: 'app', password: { id: passwordId, policy: 'save' } },
        presentation: {
          folderId: folder.id,
          tags: [],
          environment: 'production',
          readOnly: false,
          confirmWrites: false,
        },
      }),
    });
    await source.main.secrets.set({ profileId: profile.id, refId: passwordId, value: SECRET });

    const path = join(dir, 'connections.qbx');
    // Only a path picked in the save dialog.
    await expect(
      source.main.profiles.exportFile({
        path,
        profileIds: [profile.id],
        passphrase: PASSPHRASE,
        includeSecrets: true,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    source.dialogs.save = path;
    await source.main.dialogs.saveFile({ defaultName: 'connections.qbx' });
    expect(
      await source.main.profiles.exportFile({
        path,
        profileIds: [profile.id],
        passphrase: PASSPHRASE,
        includeSecrets: true,
      }),
    ).toEqual({ profiles: 1, logins: 1, unreadable: 0 });
    expect(readFileSync(path).includes(Buffer.from(SECRET))).toBe(false);

    const target = setup();
    await expect(target.main.profiles.inspectFile({ path })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    target.dialogs.open = path;
    await target.main.dialogs.openFile({});
    expect(await target.main.profiles.inspectFile({ path })).toEqual({
      format: 'querybara',
      locked: true,
      entries: [],
      skipped: [],
    });
    await expect(
      target.main.profiles.inspectFile({ path, passphrase: 'wrong' }),
    ).rejects.toMatchObject({ code: 'AUTH_FAILED' });
    const preview = await target.main.profiles.inspectFile({ path, passphrase: PASSPHRASE });
    expect(preview.entries).toEqual([
      expect.objectContaining({ key: profile.id, folder: 'Shop', savedLogins: 1, notes: [] }),
    ]);
    expect(preview.entries[0]!.existing).toBeUndefined();

    const result = await target.main.profiles.importFile({
      path,
      passphrase: PASSPHRASE,
      keys: [profile.id],
      replace: false,
    });
    expect(result).toEqual({
      added: 1,
      replaced: 0,
      skipped: 0,
      savedLogins: 1,
      unsavedLogins: 0,
      profileIds: [profile.id],
    });
    const imported = target.store.profiles.get(profile.id)!;
    expect(imported.presentation).toMatchObject({ folderId: folder.id, environment: 'production' });
    expect(target.store.secrets.resolve(imported).secrets[passwordId]).toBe(SECRET);

    // Inspected again, it now matches the imported profile.
    const again = await target.main.profiles.inspectFile({ path, passphrase: PASSPHRASE });
    expect(again.entries[0]!.existing).toEqual({ id: profile.id, name: 'Shop DB' });

    expect(source.leaked()).toBe(false);
    expect(target.leaked()).toBe(false);
  });

  it('imports the chosen connections of a Navicat file', async () => {
    const dir = tempDir();
    const path = join(dir, 'navicat.ncx');
    writeFileSync(
      path,
      `<?xml version="1.0" encoding="UTF-8"?>
<Connections Ver="1.5">
  <Connection ConnectionName="Orders" ConnType="MYSQL" Host="db" Port="3306" UserName="app" Password="${navicatPassword(NAVICAT_SECRET)}" SavePassword="true" HTTP="true"/>
  <Connection ConnectionName="Reports" ConnType="POSTGRESQL" Host="pg" Port="5432" UserName="r" Password="" SavePassword="false"/>
  <Connection ConnectionName="Legacy" ConnType="SQLSERVER" Host="mssql" Port="1433"/>
</Connections>`,
    );
    const { main, store, dialogs, leaked } = setup();
    dialogs.open = path;
    await main.dialogs.openFile({});
    const preview = await main.profiles.inspectFile({ path });
    expect(preview.format).toBe('navicat');
    expect(preview.entries.map((e) => [e.key, e.profile.name, e.savedLogins])).toEqual([
      ['0', 'Orders', 1],
      ['1', 'Reports', 0],
    ]);
    expect(preview.entries[0]!.notes).toEqual([expect.stringContaining('HTTP tunnels')]);
    expect(preview.skipped).toEqual([
      { name: 'Legacy', reason: 'SQL Server connections are not supported' },
    ]);

    const result = await main.profiles.importFile({ path, keys: ['0'], replace: false });
    expect(result).toMatchObject({ added: 1, savedLogins: 1 });
    expect(store.profiles.list().map((p) => p.name)).toEqual(['Orders']);
    const orders = store.profiles.get(result.profileIds[0]!)!;
    expect(Object.values(store.secrets.resolve(orders).secrets)).toEqual([NAVICAT_SECRET]);
    expect(leaked()).toBe(false);
  });
});
