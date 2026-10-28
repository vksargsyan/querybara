import { createDecipheriv, pbkdf2Sync } from 'node:crypto';

import {
  QuerybaraError,
  connectionProfileSchema,
  newId,
  type ConnectionProfile,
  type ConnectionProfileInput,
  type SecretRef,
  type SshHop,
} from '@querybara/core';

import { secretRecord } from '../internal/redact';
import type { SkippedConnection } from './navicat';
import { parseConnectionUri } from './uri';

/**
 * Connections exported from MongoDB Compass ("Export saved connections", a JSON file of type
 * "Compass Connections", version 1). Each connection holds a connection string and, optionally,
 * an SSH tunnel; its name and colour are under `favorite`.
 *
 * Secrets are in the file in one of three ways: in the connection string and tunnel as they are
 * (an export without a passphrase), left out ("Remove secrets"), or encrypted with the export's
 * passphrase in `connectionSecrets`: AES-256-GCM under a PBKDF2-SHA512 key (100,000 rounds),
 * laid out as version (0x0001), salt, IV, tag and ciphertext, in base64.
 */

export interface CompassConnection {
  /** The connection's position in the file, from 0. */
  readonly index: number;
  readonly profile: ConnectionProfile;
  readonly notes: readonly string[];
}

export interface CompassImport {
  readonly connections: CompassConnection[];
  /** Saved passwords by SecretRef.id; JSON and inspect show `[redacted]`. */
  readonly secrets: Readonly<Record<string, string>>;
  readonly skipped: SkippedConnection[];
}

const FILE_TYPE = 'Compass Connections';

interface CompassSecrets {
  readonly password?: string;
  readonly sshTunnelPassword?: string;
  readonly sshTunnelPassphrase?: string;
  readonly tlsCertificateKeyFilePassword?: string;
  readonly awsSessionToken?: string;
  readonly proxyPassword?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The file's JSON, or undefined when it is not JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.startsWith('﻿') ? text.slice(1) : text) as unknown;
  } catch {
    return undefined;
  }
}

/** A number, written plainly or as canonical Extended JSON (`{ "$numberInt": "1" }`). */
function plainNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (isRecord(value)) {
    const wrapped = value['$numberInt'] ?? value['$numberLong'] ?? value['$numberDouble'];
    if (typeof wrapped === 'string' && wrapped.trim() !== '') return Number(wrapped);
  }
  return undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** True when `text` is a Compass connections export. */
export function isCompassConnections(source: string): boolean {
  const parsed = parseJson(source);
  return isRecord(parsed) && parsed['type'] === FILE_TYPE && Array.isArray(parsed['connections']);
}

/** True when the export's secrets are encrypted, so its passphrase is needed. */
export function compassNeedsPassphrase(source: string): boolean {
  const parsed = parseJson(source);
  if (!isRecord(parsed) || !Array.isArray(parsed['connections'])) return false;
  return parsed['connections'].some(
    (entry) => isRecord(entry) && text(entry['connectionSecrets']) !== undefined,
  );
}

/** Decrypts one connection's secrets; AUTH_FAILED for a wrong passphrase. */
function decryptSecrets(
  encoded: string,
  passphrase: string,
  keys: Map<string, Buffer>,
): CompassSecrets {
  const data = Buffer.from(encoded, 'base64');
  if (data.length < 50 || data.readUInt16BE(0) !== 0x0001) {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: 'The encrypted secrets of a connection are in a form this version cannot read',
    });
  }
  const salt = data.subarray(2, 18);
  const iv = data.subarray(18, 34);
  const tag = data.subarray(34, 50);
  const saltKey = salt.toString('hex');
  let key = keys.get(saltKey);
  if (key === undefined) {
    key = pbkdf2Sync(Buffer.from(passphrase, 'utf8'), salt, 100_000, 32, 'sha512');
    keys.set(saltKey, key);
  }
  let plain: string;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(data.subarray(50)), decipher.final()]).toString('utf8');
  } catch {
    throw new QuerybaraError({
      code: 'AUTH_FAILED',
      message: 'The passphrase is not the one the connections were exported with',
    });
  }
  const parsed = parseJson(plain);
  const secrets = isRecord(parsed) && isRecord(parsed['secrets']) ? parsed['secrets'] : {};
  const out: Record<string, string> = {};
  for (const name of [
    'password',
    'sshTunnelPassword',
    'sshTunnelPassphrase',
    'tlsCertificateKeyFilePassword',
    'awsSessionToken',
    'proxyPassword',
  ]) {
    const value = secrets[name];
    if (typeof value === 'string' && value !== '') out[name] = value;
  }
  return out;
}

/** A connection string with its password put back, as Compass merges secrets. */
function withPassword(uri: string, password: string | undefined): string {
  if (password === undefined) return uri;
  const match = /^(mongodb(?:\+srv)?:\/\/)([^@/?]*)@/i.exec(uri);
  if (!match) return uri;
  const user = match[2]!.split(':')[0]!;
  return `${match[1]}${user}:${encodeURIComponent(password)}@${uri.slice(match[0].length)}`;
}

/** Takes a query parameter out of a connection string: the string without it, and its value. */
function takeParam(uri: string, name: string): { uri: string; value: string | undefined } {
  const queryStart = uri.indexOf('?');
  if (queryStart === -1) return { uri, value: undefined };
  let value: string | undefined;
  const kept = uri
    .slice(queryStart + 1)
    .split('&')
    .filter((pair) => {
      const [key = '', raw = ''] = pair.split('=');
      if (key.toLowerCase() !== name.toLowerCase()) return true;
      value = decodeURIComponent(raw);
      return false;
    });
  const base = uri.slice(0, queryStart);
  return { uri: kept.length > 0 ? `${base}?${kept.join('&')}` : base, value };
}

/**
 * Reads a Compass connections export. An export with encrypted secrets needs its passphrase
 * (VALIDATION_FAILED without one, AUTH_FAILED when it is wrong).
 */
export function parseCompassConnections(
  source: string,
  options: { readonly passphrase?: string; readonly now?: () => Date } = {},
): CompassImport {
  const parsed = parseJson(source);
  if (!isRecord(parsed) || parsed['type'] !== FILE_TYPE || !Array.isArray(parsed['connections'])) {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: 'The file is not a Compass connections export',
      hint: 'In Compass, choose Export saved connections and export to a JSON file.',
    });
  }
  if (plainNumber(parsed['version']) !== 1) {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: 'The Compass export is of a version this one cannot read',
    });
  }
  const passphrase = options.passphrase;
  if (compassNeedsPassphrase(source) && (passphrase === undefined || passphrase === '')) {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: 'The export holds encrypted passwords; its passphrase is needed',
    });
  }
  const now = (options.now?.() ?? new Date()).toISOString();
  const keys = new Map<string, Buffer>();
  const connections: CompassConnection[] = [];
  const skipped: SkippedConnection[] = [];
  const secrets: [string, string][] = [];
  parsed['connections'].forEach((entry: unknown, index) => {
    const result = toProfile(entry, now, passphrase, keys);
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

function toProfile(
  entry: unknown,
  now: string,
  passphrase: string | undefined,
  keys: Map<string, Buffer>,
): Converted | SkippedConnection {
  const record = isRecord(entry) ? entry : {};
  const favorite = isRecord(record['favorite']) ? record['favorite'] : {};
  const options = isRecord(record['connectionOptions']) ? record['connectionOptions'] : {};
  const connectionString = text(options['connectionString']);
  const favoriteName = text(favorite['name'])?.trim();
  if (connectionString === undefined) {
    return { name: favoriteName ?? 'A connection', reason: 'It has no connection string' };
  }
  const encrypted = text(record['connectionSecrets']);
  const hidden: CompassSecrets =
    encrypted !== undefined && passphrase !== undefined
      ? decryptSecrets(encrypted, passphrase, keys)
      : {};
  const notes: string[] = [];
  const secrets: [string, string][] = [];
  const saved = (value: string): SecretRef => {
    const ref: SecretRef = { id: newId(), policy: 'save' };
    secrets.push([ref.id, value]);
    return ref;
  };

  const tlsPassword = takeParam(
    withPassword(connectionString, hidden.password),
    'tlsCertificateKeyFilePassword',
  );
  const proxyPassword = takeParam(tlsPassword.uri, 'proxyPassword');
  let uri: ReturnType<typeof parseConnectionUri>;
  try {
    uri = parseConnectionUri(proxyPassword.uri, {
      engine: 'mongodb',
      ...(favoriteName !== undefined ? { name: favoriteName } : {}),
    });
  } catch (error) {
    return {
      name: favoriteName ?? 'A connection',
      reason:
        error instanceof QuerybaraError ? error.message : 'Its connection string is not valid',
    };
  }
  const draft = uri.profile;
  if (uri.password !== undefined && draft.auth?.method === 'password' && draft.auth.password) {
    secrets.push([draft.auth.password.id, uri.password]);
  }
  for (const name of uri.ignoredParams) {
    notes.push(`${name} is not kept.`);
  }
  if (proxyPassword.value !== undefined || hidden.proxyPassword !== undefined) {
    notes.push('The proxy password is not kept; Querybara asks for it when connecting.');
  }
  if (hidden.awsSessionToken !== undefined) {
    notes.push('The AWS session token is not kept: the AWS credential chain supplies it.');
  }

  const keyPassphrase = tlsPassword.value ?? hidden.tlsCertificateKeyFilePassword;
  const tls: ConnectionProfileInput['tls'] =
    draft.tls && keyPassphrase !== undefined && draft.tls.keyPath !== undefined
      ? { ...draft.tls, keyPassphrase: saved(keyPassphrase) }
      : draft.tls;

  const profile: ConnectionProfileInput = {
    ...draft,
    ...(tls ? { tls } : {}),
    id: newId(),
    createdAt: now,
    updatedAt: now,
  };
  const color = text(favorite['color']);
  if (color !== undefined && /^#[0-9a-fA-F]{6}$/.test(color)) {
    profile.presentation = { color: color.toLowerCase() };
  }

  const tunnel = isRecord(options['sshTunnel']) ? options['sshTunnel'] : undefined;
  if (tunnel) {
    const hop = sshHopOf(tunnel, hidden, saved);
    if (hop) profile.ssh = { hops: [hop] };
    else notes.push('The SSH tunnel has no host or user name; it was left out.');
  }
  if (options['useApplicationLevelProxy'] === true) {
    notes.push("Compass's application proxy is not used; set a proxy on the connection.");
  }
  if (isRecord(options['fleOptions']) && isRecord(options['fleOptions']['autoEncryption'])) {
    notes.push('In-use encryption settings are not imported.');
  }

  const checked = connectionProfileSchema.safeParse(profile);
  if (!checked.success) {
    return {
      name: draft.name,
      reason: checked.error.issues[0]?.message ?? 'Its settings are not valid',
    };
  }
  return { profile: checked.data, notes, secrets };
}

function sshHopOf(
  tunnel: Record<string, unknown>,
  hidden: CompassSecrets,
  saved: (value: string) => SecretRef,
): SshHop | undefined {
  const host = text(tunnel['host'])?.trim();
  const user = text(tunnel['username'])?.trim();
  if (host === undefined || user === undefined) return undefined;
  const portNumber = plainNumber(tunnel['port']);
  const port =
    portNumber !== undefined &&
    Number.isInteger(portNumber) &&
    portNumber >= 1 &&
    portNumber <= 65535
      ? portNumber
      : 22;
  const keyPath = text(tunnel['identityKeyFile'])?.trim();
  if (keyPath !== undefined) {
    const passphrase = text(tunnel['identityKeyPassphrase']) ?? hidden.sshTunnelPassphrase;
    return {
      host,
      port,
      user,
      auth: {
        method: 'privateKey',
        keyPath,
        ...(passphrase !== undefined ? { passphrase: saved(passphrase) } : {}),
      },
    };
  }
  // Without an identity file, Compass signs in to the SSH server with a password.
  const password = text(tunnel['password']) ?? hidden.sshTunnelPassword;
  return {
    host,
    port,
    user,
    auth: {
      method: 'password',
      password: password !== undefined ? saved(password) : { id: newId(), policy: 'ask' },
    },
  };
}
