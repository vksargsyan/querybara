import { createCipheriv, pbkdf2Sync, randomBytes } from 'node:crypto';

import { secretRefsOf } from '@querybara/core';
import { describe, expect, it } from 'vitest';

import {
  applyConnectionsImport,
  connectionsFileFormat,
  connectionsFileNeedsPassphrase,
  parseCompassConnections,
  parseRobo3tConnections,
  readConnectionsFile,
} from '../src';
import { memoryStore, thrown } from './helpers';

/**
 * Connections from MongoDB Compass's export (plain, without secrets, or with secrets encrypted
 * under its passphrase) and from Robo 3T's robo3t.json.
 */

const bytes = (text: string) => new TextEncoder().encode(text);
const NOW = () => new Date('2026-10-28T10:00:00.000Z');

/** Compass's Encrypter: version 0x0001, salt, IV, tag, ciphertext, in base64. */
function compassEncrypt(plain: string, passphrase: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(16);
  const key = pbkdf2Sync(Buffer.from(passphrase, 'utf8'), salt, 100_000, 32, 'sha512');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([0x00, 0x01]), salt, iv, cipher.getAuthTag(), body]).toString(
    'base64',
  );
}

function compassFile(connections: unknown[], canonical = false): string {
  return JSON.stringify({
    type: 'Compass Connections',
    version: canonical ? { $numberInt: '1' } : 1,
    connections,
  });
}

describe('MongoDB Compass exports', () => {
  const plain = compassFile([
    {
      id: '1c4c0e0e-0000-4000-8000-000000000001',
      favorite: { name: 'Atlas shop', color: '#00A35C' },
      savedConnectionType: 'favorite',
      connectionOptions: {
        connectionString:
          'mongodb+srv://shop:s3cr%40t@cluster0.abcde.mongodb.net/shop?authSource=admin&appName=Compass',
      },
    },
    {
      id: '1c4c0e0e-0000-4000-8000-000000000002',
      favorite: { name: 'Behind a bastion' },
      connectionOptions: {
        connectionString: 'mongodb://10.0.0.5:27017/?directConnection=true',
        sshTunnel: { host: 'bastion.example.com', port: 2222, username: 'ops', password: 'ssh-pw' },
      },
    },
    { id: 'x', favorite: { name: 'Broken' }, connectionOptions: {} },
  ]);

  it('reads names, connection strings, colours, tunnels and the passwords in the file', () => {
    expect(connectionsFileFormat(bytes(plain))).toBe('compass');
    expect(connectionsFileNeedsPassphrase(bytes(plain))).toBe(false);
    const imported = parseCompassConnections(plain, { now: NOW });
    const [atlas, bastion] = imported.connections;
    expect(atlas!.profile).toMatchObject({
      name: 'Atlas shop',
      engine: 'mongodb',
      endpoint: { kind: 'srv', host: 'cluster0.abcde.mongodb.net' },
      auth: { method: 'password', user: 'shop' },
      tls: { mode: 'verify-full' },
      presentation: { color: '#00a35c' },
    });
    const ref = secretRefsOf(atlas!.profile)[0]!;
    expect(imported.secrets[ref.id]).toBe('s3cr@t');
    expect(bastion!.profile.ssh?.hops[0]).toMatchObject({
      host: 'bastion.example.com',
      port: 2222,
      user: 'ops',
      auth: { method: 'password' },
    });
    expect(Object.values(imported.secrets)).toContain('ssh-pw');
    expect(imported.skipped).toEqual([{ name: 'Broken', reason: 'It has no connection string' }]);
    expect(JSON.stringify(imported.secrets)).not.toContain('s3cr@t');
  });

  it('decrypts the secrets of a passphrase-protected export, and refuses a wrong passphrase', () => {
    const secrets = compassEncrypt(
      JSON.stringify({
        secrets: {
          password: 'enc-pw',
          sshTunnelPassphrase: 'key-pass',
          tlsCertificateKeyFilePassword: 'pem-pass',
        },
      }),
      'compass pass',
    );
    const file = compassFile(
      [
        {
          id: 'a',
          favorite: { name: 'Encrypted' },
          connectionOptions: {
            connectionString:
              'mongodb://app@db.example.com:27017/?tls=true&tlsCertificateKeyFile=%2Fcerts%2Fapp.pem',
            sshTunnel: {
              host: 'jump',
              port: { $numberInt: '22' },
              username: 'me',
              identityKeyFile: '/home/me/.ssh/id_ed25519',
            },
          },
          connectionSecrets: secrets,
        },
      ],
      true,
    );
    expect(connectionsFileNeedsPassphrase(bytes(file))).toBe(true);
    expect(thrown(() => readConnectionsFile(bytes(file)))).toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    expect(thrown(() => parseCompassConnections(file, { passphrase: 'wrong' }))).toMatchObject({
      code: 'AUTH_FAILED',
    });
    const read = readConnectionsFile(bytes(file), { passphrase: 'compass pass', now: NOW });
    expect(read.format).toBe('compass');
    const profile = read.entries[0]!.profile;
    expect(profile.tls).toMatchObject({ mode: 'verify-full', keyPath: '/certs/app.pem' });
    expect(profile.ssh?.hops[0]?.auth).toMatchObject({
      method: 'privateKey',
      keyPath: '/home/me/.ssh/id_ed25519',
    });
    const values = secretRefsOf(profile).map((ref) => read.secrets[ref.id]);
    expect(values.sort()).toEqual(['enc-pw', 'key-pass', 'pem-pass']);
  });

  it('imports into the store, replacing by engine and name the second time', () => {
    const store = memoryStore();
    const file = readConnectionsFile(bytes(plain), { now: NOW });
    expect(applyConnectionsImport(store, file, { replace: false }).added).toBe(2);
    const again = applyConnectionsImport(store, readConnectionsFile(bytes(plain)), {
      replace: true,
    });
    expect(again).toMatchObject({ added: 0, replaced: 2 });
  });
});

describe('Robo 3T settings', () => {
  const settings = JSON.stringify({
    autoExpand: true,
    connections: [
      {
        connectionName: 'Local',
        serverHost: 'localhost',
        serverPort: 27017,
        defaultDatabase: 'shop',
        isReplicaSet: false,
        credentials: [
          {
            enabled: true,
            userName: 'app',
            userPassword: 'old-style',
            databaseName: 'admin',
            mechanism: 'SCRAM-SHA-1',
          },
        ],
        ssh: { enabled: false },
        ssl: { sslEnabled: false },
        uuid: '{a}',
      },
      {
        connectionName: 'Replica set over SSH',
        serverHost: 'm1',
        serverPort: 27017,
        isReplicaSet: true,
        replicaSet: {
          setNameUserEntered: 'rs0',
          cachedSetName: 'rs0',
          '0': 'm1:27017',
          '1': 'm2:27018',
          readPreference: 1,
        },
        credentials: [
          {
            enabled: true,
            userName: 'ops',
            userPasswordEncrypted: 'c2VjcmV0',
            databaseName: 'users',
            mechanism: 'MONGODB-CR',
          },
        ],
        ssh: {
          enabled: true,
          host: 'bastion',
          port: 22,
          userName: 'me',
          method: 'publickey',
          privateKeyFile: '/home/me/.ssh/id_rsa',
          passphraseEncrypted: '',
        },
        ssl: {
          sslEnabled: true,
          caFile: '/certs/ca.pem',
          usePemFile: true,
          pemKeyFile: '/certs/me.pem',
          allowInvalidHostnames: true,
          pemPassPhraseEncrypted: 'eA==',
        },
      },
    ],
  });

  it('reads hosts, replica sets, credentials, SSH and TLS', () => {
    expect(connectionsFileFormat(bytes(settings))).toBe('robo3t');
    expect(connectionsFileNeedsPassphrase(bytes(settings))).toBe(false);
    const imported = parseRobo3tConnections(settings, { now: NOW });
    const [local, replica] = imported.connections;
    expect(local!.profile).toMatchObject({
      name: 'Local',
      endpoint: { kind: 'host', host: 'localhost', port: 27017 },
      auth: { method: 'password', user: 'app', mechanism: 'SCRAM-SHA-1' },
      options: { defaultDatabase: 'shop', authSource: 'admin' },
      tls: { mode: 'disable' },
    });
    expect(imported.secrets[secretRefsOf(local!.profile)[0]!.id]).toBe('old-style');

    expect(replica!.profile).toMatchObject({
      endpoint: {
        kind: 'hosts',
        hosts: [
          { host: 'm1', port: 27017 },
          { host: 'm2', port: 27018 },
        ],
        replicaSet: 'rs0',
      },
      auth: { method: 'password', user: 'ops', password: { policy: 'ask' } },
      options: { authSource: 'users', readPreference: 'primaryPreferred' },
      tls: {
        mode: 'verify-ca',
        caPath: '/certs/ca.pem',
        certPath: '/certs/me.pem',
        keyPath: '/certs/me.pem',
        keyPassphrase: { policy: 'ask' },
      },
    });
    expect(replica!.profile.auth).not.toHaveProperty('mechanism');
    expect(replica!.profile.ssh?.hops[0]).toEqual({
      host: 'bastion',
      port: 22,
      user: 'me',
      auth: { method: 'privateKey', keyPath: '/home/me/.ssh/id_rsa' },
    });
    expect(replica!.notes).toEqual([
      'MONGODB-CR is not offered; the server picks the mechanism.',
      "The saved password and certificate passphrase are encrypted with Robo 3T's key; Querybara asks when connecting.",
    ]);
  });

  it('is not mistaken for other JSON', () => {
    expect(connectionsFileFormat(bytes('{"connections": []}'))).toBeUndefined();
    expect(connectionsFileFormat(bytes('{"type": "Compass Connections"}'))).toBeUndefined();
  });
});
