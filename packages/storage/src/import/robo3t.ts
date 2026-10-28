import {
  ENGINES,
  QuerybaraError,
  connectionProfileSchema,
  newId,
  type ConnectionProfile,
  type ConnectionProfileInput,
  type SecretRef,
  type SshHop,
  type TlsMode,
} from '@querybara/core';

import { secretRecord } from '../internal/redact';
import type { SkippedConnection } from './navicat';

/**
 * Connections of Robo 3T, from its settings file (`robo3t.json`, in `~/.3T/robo-3t/<version>/`):
 * a `connections` list, each with a host and port or a replica set, a credential, and SSH and
 * TLS settings.
 *
 * Robo 3T 1.2 and older keep passwords as they are; 1.3 and later encrypt them with a key of
 * the computer they were saved on, which Querybara cannot read, so it asks for those when
 * connecting.
 */

export interface Robo3tConnection {
  /** The connection's position in the file, from 0. */
  readonly index: number;
  readonly profile: ConnectionProfile;
  readonly notes: readonly string[];
}

export interface Robo3tImport {
  readonly connections: Robo3tConnection[];
  /** Saved passwords by SecretRef.id; JSON and inspect show `[redacted]`. */
  readonly secrets: Readonly<Record<string, string>>;
  readonly skipped: SkippedConnection[];
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.startsWith('﻿') ? text.slice(1) : text) as unknown;
  } catch {
    return undefined;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function portOf(value: unknown, fallback: number): number {
  const port = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback;
}

/** True when `text` is a Robo 3T settings file with connections. */
export function isRobo3tConnections(source: string): boolean {
  const parsed = parseJson(source);
  if (!isRecord(parsed) || !Array.isArray(parsed['connections'])) return false;
  return parsed['connections'].some(
    (entry) => isRecord(entry) && ('serverHost' in entry || 'connectionName' in entry),
  );
}

/** Reads Robo 3T's settings file. Fails with VALIDATION_FAILED when it is not one. */
export function parseRobo3tConnections(
  source: string,
  options: { readonly now?: () => Date } = {},
): Robo3tImport {
  const parsed = parseJson(source);
  if (!isRobo3tConnections(source) || !isRecord(parsed)) {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: 'The file is not a Robo 3T settings file',
      hint: 'Choose robo3t.json in the .3T/robo-3t/<version> folder of your home folder.',
    });
  }
  const now = (options.now?.() ?? new Date()).toISOString();
  const connections: Robo3tConnection[] = [];
  const skipped: SkippedConnection[] = [];
  const secrets: [string, string][] = [];
  (parsed['connections'] as unknown[]).forEach((entry, index) => {
    const result = toProfile(isRecord(entry) ? entry : {}, now);
    if ('reason' in result) {
      skipped.push(result);
      return;
    }
    connections.push({ index, profile: result.profile, notes: result.notes });
    secrets.push(...result.secrets);
  });
  return { connections, secrets: secretRecord(secrets), skipped };
}

interface Converted {
  readonly profile: ConnectionProfile;
  readonly notes: string[];
  readonly secrets: [string, string][];
}

interface SecretField {
  (map: Json, plain: string, encrypted: string, label: string): SecretRef;
  /** An optional secret (a key passphrase): undefined when Robo 3T saved none. */
  (
    map: Json,
    plain: string,
    encrypted: string,
    label: string,
    optional: true,
  ): SecretRef | undefined;
}

function toProfile(entry: Json, now: string): Converted | SkippedConnection {
  const host = text(entry['serverHost']) ?? 'localhost';
  const name = text(entry['connectionName']) ?? host;
  const notes: string[] = [];
  const secrets: [string, string][] = [];
  const unread = new Set<string>();
  /** A secret Robo 3T saved: kept when it is in the clear, asked for when encrypted. */
  const secret = ((
    map: Json,
    plain: string,
    encrypted: string,
    label: string,
    optional = false,
  ) => {
    const value = typeof map[plain] === 'string' ? (map[plain] as string) : '';
    if (value !== '') {
      const ref: SecretRef = { id: newId(), policy: 'save' };
      secrets.push([ref.id, value]);
      return ref;
    }
    const saved = text(map[encrypted]) !== undefined;
    if (saved) unread.add(label);
    return optional && !saved ? undefined : { id: newId(), policy: 'ask' };
  }) as SecretField;

  // Endpoint: a host, or a replica set's members.
  let endpoint: ConnectionProfileInput['endpoint'] = {
    kind: 'host',
    host,
    port: portOf(entry['serverPort'], ENGINES.mongodb.defaultPort),
  };
  const options: NonNullable<ConnectionProfileInput['options']> = {};
  const replica = isRecord(entry['replicaSet']) ? entry['replicaSet'] : undefined;
  if (entry['isReplicaSet'] === true && replica) {
    const members: { host: string; port: number }[] = [];
    for (let index = 0; typeof replica[String(index)] === 'string'; index++) {
      const member = (replica[String(index)] as string).trim();
      const colon = member.lastIndexOf(':');
      const memberHost = colon === -1 ? member : member.slice(0, colon);
      const port = colon === -1 ? ENGINES.mongodb.defaultPort : portOf(member.slice(colon + 1), 0);
      if (memberHost !== '' && port !== 0) members.push({ host: memberHost, port });
    }
    const setName = text(replica['setNameUserEntered']) ?? text(replica['cachedSetName']);
    if (members.length > 0) {
      endpoint = { kind: 'hosts', hosts: members, ...(setName ? { replicaSet: setName } : {}) };
    }
    if (replica['readPreference'] === 1) options.readPreference = 'primaryPreferred';
  }
  const database = text(entry['defaultDatabase']);
  if (database !== undefined) options.defaultDatabase = database;

  // The credential: Robo 3T uses the first enabled one.
  const credential = (Array.isArray(entry['credentials']) ? entry['credentials'] : [])
    .filter(isRecord)
    .find((c) => c['enabled'] === true);
  let auth: ConnectionProfileInput['auth'] = { method: 'none' };
  const user = credential ? text(credential['userName']) : undefined;
  if (credential && user !== undefined) {
    const mechanism = text(credential['mechanism'])?.toUpperCase();
    const supported = mechanism === 'SCRAM-SHA-1' || mechanism === 'SCRAM-SHA-256';
    if (mechanism !== undefined && !supported) {
      notes.push(`${mechanism} is not offered; the server picks the mechanism.`);
    }
    auth = {
      method: 'password',
      user,
      password: secret(credential, 'userPassword', 'userPasswordEncrypted', 'password'),
      ...(supported ? { mechanism } : {}),
    };
    options.authSource = text(credential['databaseName']) ?? 'admin';
  }

  const profile: ConnectionProfileInput = {
    id: newId(),
    name,
    engine: 'mongodb',
    endpoint,
    auth,
    tls: tlsOf(entry, secret, notes),
    options,
    createdAt: now,
    updatedAt: now,
  };

  const ssh = isRecord(entry['ssh']) ? entry['ssh'] : undefined;
  if (ssh && ssh['enabled'] === true) {
    const hop = sshHopOf(ssh, secret);
    if (hop) profile.ssh = { hops: [hop] };
    else notes.push('The SSH tunnel has no host or user name; it was left out.');
  }
  if (unread.size > 0) {
    notes.push(
      `The saved ${[...unread].join(' and ')} ${unread.size === 1 ? 'is' : 'are'} encrypted with Robo 3T's key; Querybara asks when connecting.`,
    );
  }

  const checked = connectionProfileSchema.safeParse(profile);
  if (!checked.success) {
    return { name, reason: checked.error.issues[0]?.message ?? 'Its settings are not valid' };
  }
  return { profile: checked.data, notes, secrets };
}

function tlsOf(
  entry: Json,
  secret: SecretField,
  notes: string[],
): NonNullable<ConnectionProfileInput['tls']> {
  const ssl = isRecord(entry['ssl']) ? entry['ssl'] : undefined;
  if (!ssl || ssl['sslEnabled'] !== true) return { mode: 'disable' };
  const mode: TlsMode =
    ssl['allowInvalidCertificates'] === true
      ? 'require'
      : ssl['allowInvalidHostnames'] === true
        ? 'verify-ca'
        : 'verify-full';
  const caPath = text(ssl['caFile']);
  const pem = ssl['usePemFile'] === true ? text(ssl['pemKeyFile']) : undefined;
  const keyPassphrase =
    pem === undefined
      ? undefined
      : secret(ssl, 'pemPassPhrase', 'pemPassPhraseEncrypted', 'certificate passphrase', true);
  if (text(ssl['crlFile']) !== undefined) {
    notes.push('The certificate revocation list is not used.');
  }
  return {
    mode,
    ...(caPath !== undefined ? { caPath } : {}),
    ...(pem !== undefined ? { certPath: pem, keyPath: pem } : {}),
    ...(keyPassphrase !== undefined ? { keyPassphrase } : {}),
  };
}

function sshHopOf(ssh: Json, secret: SecretField): SshHop | undefined {
  const host = text(ssh['host']);
  const user = text(ssh['userName']);
  if (host === undefined || user === undefined) return undefined;
  const port = portOf(ssh['port'], 22);
  if (text(ssh['method']) === 'password') {
    return {
      host,
      port,
      user,
      auth: {
        method: 'password',
        password: secret(ssh, 'userPassword', 'userPasswordEncrypted', 'SSH password'),
      },
    };
  }
  const keyPath = text(ssh['privateKeyFile']);
  if (keyPath === undefined) return { host, port, user, auth: { method: 'agent' } };
  const passphrase = secret(ssh, 'passphrase', 'passphraseEncrypted', 'SSH key passphrase', true);
  return {
    host,
    port,
    user,
    auth: { method: 'privateKey', keyPath, ...(passphrase !== undefined ? { passphrase } : {}) },
  };
}
