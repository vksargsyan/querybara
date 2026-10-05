import { newId, secretRefsOf } from '@querybara/core';
import { describe, expect, it } from 'vitest';

import {
  applyConnectionsImport,
  connectionsFileFormat,
  exportProfiles,
  readConnectionsFile,
  type SecretSealer,
} from '../src';
import { TEST_COST, memoryStore, postgresProfile, thrown } from './helpers';
import { connection, navicatPassword, ncx } from './navicat-fixtures';

const PASSPHRASE = 'file passphrase';
const bytes = (text: string) => new TextEncoder().encode(text);

const noKeychain: SecretSealer = {
  id: 'none',
  isAvailable: () => false,
  seal: () => {
    throw new Error('unavailable');
  },
  unseal: () => {
    throw new Error('unavailable');
  },
};

function exported() {
  const source = memoryStore();
  const folder = source.folders.create({ name: 'Shop' });
  const password = { id: newId(), policy: 'save' as const };
  const pg = source.profiles.save(
    postgresProfile({
      name: 'Shop',
      auth: { method: 'password', user: 'app', password },
      presentation: { folderId: folder.id },
    }),
  );
  const data = exportProfiles([pg], {
    passphrase: PASSPHRASE,
    folders: [folder],
    secrets: { [password.id]: 'pg-pass' },
    cost: TEST_COST,
  });
  return { data, pg, folder, password };
}

describe('connections files', () => {
  it('tells the formats apart', () => {
    expect(connectionsFileFormat(exported().data)).toBe('querybara');
    expect(connectionsFileFormat(bytes(ncx()))).toBe('navicat');
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(ncx(), 'utf16le')]);
    expect(connectionsFileFormat(utf16)).toBe('navicat');
    expect(connectionsFileFormat(bytes('id,name\n1,x'))).toBeUndefined();
    expect(connectionsFileFormat(new Uint8Array([0xc3, 0x28]))).toBeUndefined();
    expect(thrown(() => readConnectionsFile(bytes('{}')))).toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('needs the passphrase of a Querybara export', () => {
    const { data, pg } = exported();
    expect(thrown(() => readConnectionsFile(data))).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(thrown(() => readConnectionsFile(data, { passphrase: 'wrong' }))).toMatchObject({
      code: 'AUTH_FAILED',
    });
    const file = readConnectionsFile(data, { passphrase: PASSPHRASE });
    expect(file.format).toBe('querybara');
    expect(file.entries.map((e) => e.key)).toEqual([pg.id]);
  });

  it('imports a Querybara export with its folders and secrets, then skips or replaces', () => {
    const { data, pg, folder, password } = exported();
    const store = memoryStore();
    const file = readConnectionsFile(data, { passphrase: PASSPHRASE });
    expect(applyConnectionsImport(store, file, { replace: false })).toEqual({
      added: 1,
      replaced: 0,
      skipped: 0,
      savedSecrets: 1,
      unsavedSecrets: 0,
      written: [{ key: pg.id, profileId: pg.id }],
    });
    expect(store.folders.get(folder.id)?.name).toBe('Shop');
    expect(store.profiles.get(pg.id)?.presentation.folderId).toBe(folder.id);
    expect(store.secrets.resolve(store.profiles.get(pg.id)!).secrets[password.id]).toBe('pg-pass');

    expect(applyConnectionsImport(store, file, { replace: false })).toMatchObject({
      added: 0,
      skipped: 1,
    });
    expect(applyConnectionsImport(store, file, { replace: true })).toMatchObject({
      replaced: 1,
      written: [{ key: pg.id, profileId: pg.id }],
    });
    expect(store.profiles.list()).toHaveLength(1);
  });

  it('imports the chosen Navicat connections and replaces them by name on a second import', () => {
    const store = memoryStore();
    const text = ncx(
      connection({
        ConnectionName: 'Orders',
        Password: navicatPassword('orders-pass'),
        SavePassword: 'true',
      }),
      connection({ ConnectionName: 'Reports', ConnType: 'POSTGRESQL', Port: '5432' }),
      connection({ ConnectionName: 'Legacy', ConnType: 'ORACLE' }),
    );
    const first = readConnectionsFile(bytes(text));
    expect(first.format).toBe('navicat');
    expect(first.entries.map((e) => [e.key, e.profile.name])).toEqual([
      ['0', 'Orders'],
      ['1', 'Reports'],
    ]);
    expect(first.skipped).toEqual([
      { name: 'Legacy', reason: 'Oracle connections are not supported' },
    ]);

    const result = applyConnectionsImport(store, first, { keys: ['0'], replace: false });
    expect(result).toMatchObject({ added: 1, savedSecrets: 1 });
    const orders = store.profiles.get(result.written[0]!.profileId)!;
    expect(orders.name).toBe('Orders');
    const [ref] = secretRefsOf(orders);
    expect(store.secrets.resolve(orders).secrets[ref!.id]).toBe('orders-pass');

    // Read again: new ids, but "Orders" matches the profile it created.
    const second = readConnectionsFile(bytes(text));
    expect(applyConnectionsImport(store, second, { replace: false })).toMatchObject({
      added: 1,
      skipped: 1,
    });
    expect(applyConnectionsImport(store, second, { keys: ['0'], replace: true })).toMatchObject({
      replaced: 1,
      written: [{ key: '0', profileId: orders.id }],
    });
    expect(store.profiles.list().map((p) => p.name)).toEqual(['Orders', 'Reports']);
  });

  it('counts secrets it cannot save without a keychain', () => {
    const store = memoryStore({ sealer: noKeychain });
    const file = readConnectionsFile(
      bytes(ncx(connection({ Password: navicatPassword('x'), SavePassword: 'true' }))),
    );
    expect(applyConnectionsImport(store, file, { replace: false })).toMatchObject({
      added: 1,
      savedSecrets: 0,
      unsavedSecrets: 1,
    });
  });
});
