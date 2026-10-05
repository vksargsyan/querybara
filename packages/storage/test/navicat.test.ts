import { inspect } from 'node:util';

import { QuerybaraError } from '@querybara/core';
import { describe, expect, it } from 'vitest';

import {
  REDACTED,
  decryptNavicatPassword,
  isNavicatConnections,
  parseNavicatConnections,
} from '../src';
import { thrown } from './helpers';
import { connection, navicatPassword, ncx } from './navicat-fixtures';

describe('Navicat password cipher', () => {
  it('reads Navicat 12+ (AES) and Navicat 11 (Blowfish) passwords', () => {
    expect(decryptNavicatPassword('B75D320B6211468D63EB3B67C9E85933')).toBe('This is a test');
    expect(decryptNavicatPassword('0EA71F51DD37BFB60CCBA219BE3A')).toBe('This is a test');
    expect(decryptNavicatPassword(navicatPassword('pässwörd: 16 bytes+'))).toBe(
      'pässwörd: 16 bytes+',
    );
    expect(decryptNavicatPassword('')).toBe('');
  });

  it('refuses text that is not hex', () => {
    expect(decryptNavicatPassword('not hex')).toBeUndefined();
    expect(decryptNavicatPassword('ABC')).toBeUndefined();
  });
});

describe('Navicat connections file', () => {
  it('recognises an .ncx file', () => {
    expect(isNavicatConnections(ncx())).toBe(true);
    expect(isNavicatConnections('﻿<Connections Ver="1.1"></Connections>')).toBe(true);
    expect(isNavicatConnections('<Connection/>')).toBe(false);
    expect(isNavicatConnections('{"format":"x"}')).toBe(false);
    const error = thrown(() => parseNavicatConnections('<html/>'));
    expect(error).toBeInstanceOf(QuerybaraError);
    expect((error as QuerybaraError).code).toBe('VALIDATION_FAILED');
  });

  it('maps MySQL, PostgreSQL, MariaDB, MongoDB and Redis connections', () => {
    const parsed = parseNavicatConnections(
      ncx(
        connection({
          ConnectionName: 'Shop & "orders"',
          Host: 'db.example.com',
          Port: '3307',
          Database: 'shop',
          UserName: 'app',
          Password: navicatPassword('s3cret'),
          SavePassword: 'true',
        }),
        connection({ ConnectionName: 'PG', ConnType: 'POSTGRESQL', Port: '5433' }),
        connection({ ConnectionName: 'Maria', ConnType: 'MARIADB', Port: 'x' }),
        connection({ ConnectionName: 'Mongo', ConnType: 'MONGODB', Port: '27017', UserName: '' }),
        connection({
          ConnectionName: 'Cache',
          ConnType: 'REDIS',
          Port: '6380',
          UserName: '',
          Database: '2',
          Password: navicatPassword('redis-pass'),
          SavePassword: 'true',
        }),
      ),
      { now: () => new Date('2026-10-01T00:00:00.000Z') },
    );
    expect(parsed.skipped).toEqual([]);
    const [mysql, pg, maria, mongo, redis] = parsed.connections.map((c) => c.profile);

    expect(mysql).toMatchObject({
      name: 'Shop & "orders"',
      engine: 'mysql',
      endpoint: { kind: 'host', host: 'db.example.com', port: 3307 },
      auth: { method: 'password', user: 'app', password: { policy: 'save' } },
      tls: { mode: 'disable' },
      options: { defaultDatabase: 'shop' },
      createdAt: '2026-10-01T00:00:00.000Z',
    });
    const mysqlRef = mysql!.auth.method === 'password' ? mysql!.auth.password! : undefined;
    expect(parsed.secrets[mysqlRef!.id]).toBe('s3cret');

    // Not saved: asked for when connecting.
    expect(pg).toMatchObject({
      engine: 'postgres',
      endpoint: { port: 5433 },
      auth: { method: 'password', user: 'root', password: { policy: 'ask' } },
    });
    expect(maria).toMatchObject({ engine: 'mariadb', endpoint: { port: 3306 } });
    expect(mongo).toMatchObject({ engine: 'mongodb', auth: { method: 'none' } });
    expect(redis).toMatchObject({
      engine: 'redis',
      endpoint: { port: 6380 },
      auth: { method: 'password', password: { policy: 'save' } },
      options: { defaultDatabase: '2' },
    });
    expect(parsed.connections.map((c) => c.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it('keeps passwords out of JSON and inspect', () => {
    const parsed = parseNavicatConnections(
      ncx(connection({ Password: navicatPassword('hunter2'), SavePassword: 'true' })),
    );
    expect(JSON.stringify(parsed)).not.toContain('hunter2');
    expect(inspect(parsed, { depth: 10 })).not.toContain('hunter2');
    expect(JSON.stringify(parsed.secrets)).toContain(REDACTED);
  });

  it('carries over SSL and SSH settings', () => {
    const parsed = parseNavicatConnections(
      ncx(
        connection({
          ConnType: 'POSTGRESQL',
          SSL: 'true',
          SSL_PGSSLMode: 'VERIFY_FULL',
          SSL_CACert: '/certs/ca.pem',
          SSL_ClientCert: '/certs/client.pem',
          SSL_ClientKey: '/certs/client.key',
          SSH: 'true',
          SSH_Host: 'bastion.example.com',
          SSH_Port: '2222',
          SSH_UserName: 'ops',
          SSH_Password: navicatPassword('ssh-pass'),
          SSH_SavePassword: 'true',
        }),
        connection({
          SSL: 'true',
          SSL_CACert: '/certs/ca.pem',
          SSL_AllowInvalidHostName: 'true',
          SSH: 'true',
          SSH_Host: 'bastion',
          SSH_UserName: 'ops',
          SSH_AuthenMethod: 'PUBLICKEY',
          SSH_PrivateKey: '/home/me/.ssh/id_ed25519',
          SSH_Passphrase: navicatPassword('key-pass'),
          SSH_SavePassphrase: 'true',
        }),
        connection({
          SSL: 'true',
          SSH: 'true',
          SSH_Host: 'b',
          SSH_UserName: 'u',
          SSH_AuthenMethod: 'PUBLICKEY',
        }),
      ),
    );
    const [pg, mysql, agent] = parsed.connections.map((c) => c.profile);
    expect(pg!.tls).toEqual({
      mode: 'verify-full',
      caPath: '/certs/ca.pem',
      certPath: '/certs/client.pem',
      keyPath: '/certs/client.key',
    });
    expect(pg!.ssh?.hops).toMatchObject([
      {
        host: 'bastion.example.com',
        port: 2222,
        user: 'ops',
        auth: { method: 'password', password: { policy: 'save' } },
      },
    ]);
    const hop = pg!.ssh!.hops[0]!;
    expect(parsed.secrets[hop.auth.method === 'password' ? hop.auth.password.id : '']).toBe(
      'ssh-pass',
    );

    expect(mysql!.tls).toMatchObject({ mode: 'verify-ca', caPath: '/certs/ca.pem' });
    const keyHop = mysql!.ssh!.hops[0]!;
    expect(keyHop.auth).toMatchObject({
      method: 'privateKey',
      keyPath: '/home/me/.ssh/id_ed25519',
      passphrase: { policy: 'save' },
    });
    expect(
      parsed.secrets[keyHop.auth.method === 'privateKey' ? keyHop.auth.passphrase!.id : ''],
    ).toBe('key-pass');

    expect(agent!.tls.mode).toBe('require');
    expect(agent!.ssh!.hops[0]!.auth).toEqual({ method: 'agent' });
  });

  it('uses a socket file, and notes what it leaves out', () => {
    const parsed = parseNavicatConnections(
      ncx(
        connection({ NamedPipe: 'true', NamedPipeSocket: '/tmp/mysql.sock' }),
        connection({ NamedPipe: 'true', NamedPipeSocket: 'MySQL', HTTP: 'true' }),
        connection({ Password: 'zz', SavePassword: 'true', SSH: 'true' }),
      ),
    );
    const [socket, pipe, broken] = parsed.connections;
    expect(socket!.profile.endpoint).toEqual({ kind: 'socket', path: '/tmp/mysql.sock' });
    expect(socket!.notes).toEqual([]);
    expect(pipe!.profile.endpoint).toEqual({ kind: 'host', host: 'localhost', port: 3306 });
    expect(pipe!.notes).toHaveLength(2);
    expect(broken!.profile.auth).toMatchObject({ password: { policy: 'ask' } });
    expect(broken!.profile.ssh).toBeUndefined();
    expect(broken!.notes).toEqual([
      expect.stringContaining('saved password could not be read'),
      expect.stringContaining('SSH tunnel'),
    ]);
    expect(Object.keys(parsed.secrets)).toEqual([]);
  });

  it('lists connection types it cannot import', () => {
    const parsed = parseNavicatConnections(
      ncx(
        connection({ ConnectionName: 'ora', ConnType: 'ORACLE' }),
        connection({ ConnectionName: 'mssql', ConnType: 'SQLSERVER' }),
        connection({ ConnectionName: 'mine', ConnType: 'MYSQL' }),
      ),
    );
    expect(parsed.skipped).toEqual([
      { name: 'ora', reason: 'Oracle connections are not supported' },
      { name: 'mssql', reason: 'SQL Server connections are not supported' },
    ]);
    expect(parsed.connections.map((c) => [c.index, c.profile.name])).toEqual([[2, 'mine']]);
  });
});
