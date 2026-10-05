import {
  ENGINES,
  QuerybaraError,
  connectionProfileSchema,
  newId,
  type ConnectionProfile,
  type ConnectionProfileInput,
  type EngineId,
  type SecretRef,
  type SshHop,
  type TlsMode,
} from '@querybara/core';

import { secretRecord } from '../internal/redact';
import { decryptNavicatPassword } from './navicat-cipher';

/**
 * Connections exported from Navicat ("Export Connections…", an `.ncx` file): an XML document
 * with one `<Connection>` element per connection, its settings as attributes. Saved passwords
 * are in the file, under a cipher with a public key (navicat-cipher.ts).
 *
 * MySQL, MariaDB, PostgreSQL, MongoDB and Redis connections are read; the host, port, user,
 * password, initial database, socket file, SSL and SSH settings carry over. Other connection
 * types are listed as skipped, and settings Querybara has no place for (an HTTP tunnel, a
 * Windows named pipe) are left out with a note on the connection.
 */

export interface NavicatConnection {
  /** The connection's position in the file, from 0: stable across reads of the same file. */
  readonly index: number;
  readonly profile: ConnectionProfile;
  /** What did not carry over, one sentence each. */
  readonly notes: readonly string[];
}

export interface SkippedConnection {
  readonly name: string;
  readonly reason: string;
}

export interface NavicatImport {
  readonly connections: NavicatConnection[];
  /** Saved passwords by SecretRef.id; JSON and inspect show `[redacted]`. */
  readonly secrets: Readonly<Record<string, string>>;
  readonly skipped: SkippedConnection[];
}

const CONN_TYPES: Readonly<Record<string, EngineId>> = {
  MYSQL: 'mysql',
  MARIADB: 'mariadb',
  POSTGRESQL: 'postgres',
  MONGODB: 'mongodb',
  REDIS: 'redis',
};

const UNSUPPORTED_NAMES: Readonly<Record<string, string>> = {
  ORACLE: 'Oracle',
  SQLSERVER: 'SQL Server',
  SQLITE: 'SQLite',
  SNOWFLAKE: 'Snowflake',
};

/** True when `text` looks like a Navicat connections file (a `<Connections>` root). */
export function isNavicatConnections(text: string): boolean {
  return /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<Connections[\s>]/.test(stripBom(text));
}

/** Reads a Navicat `.ncx` file. Fails with VALIDATION_FAILED when it is not one. */
export function parseNavicatConnections(
  text: string,
  options: { readonly now?: () => Date } = {},
): NavicatImport {
  if (!isNavicatConnections(text)) {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: 'The file is not a Navicat connections file',
      hint: 'In Navicat, choose File > Export Connections and export to an .ncx file.',
    });
  }
  const now = (options.now?.() ?? new Date()).toISOString();
  const connections: NavicatConnection[] = [];
  const skipped: SkippedConnection[] = [];
  const secrets: [string, string][] = [];
  const elements = [...stripBom(text).matchAll(/<Connection\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g)];
  elements.forEach((match, index) => {
    const attrs = parseAttributes(match[1] ?? '');
    const result = toProfile(attrs, now);
    if ('reason' in result) {
      skipped.push(result);
      return;
    }
    connections.push({ index, profile: result.profile, notes: result.notes });
    secrets.push(...result.secrets);
  });
  return { connections, secrets: secretRecord(secrets), skipped };
}

// ---------------------------------------------------------------------------------------------

type Attributes = ReadonlyMap<string, string>;

interface Converted {
  readonly profile: ConnectionProfile;
  readonly notes: string[];
  readonly secrets: [string, string][];
}

function toProfile(attrs: Attributes, now: string): Converted | SkippedConnection {
  const type = (attrs.get('ConnType') ?? '').trim().toUpperCase();
  const host = attrs.get('Host')?.trim() || 'localhost';
  const name = attrs.get('ConnectionName')?.trim() || host;
  const engine = CONN_TYPES[type];
  if (engine === undefined) {
    const what = UNSUPPORTED_NAMES[type] ?? (type === '' ? 'An unknown type' : type);
    return { name, reason: `${what} connections are not supported` };
  }

  const notes: string[] = [];
  const secrets: [string, string][] = [];
  /** A SecretRef for a password field: saved when Navicat saved it and it can be read. */
  const secret = (
    field: string,
    saved: boolean,
    label: string,
  ): { ref: SecretRef; hasValue: boolean } => {
    const ref: SecretRef = { id: newId(), policy: 'ask' };
    const raw = attrs.get(field) ?? '';
    if (!saved || raw === '') return { ref, hasValue: false };
    const value = decryptNavicatPassword(raw);
    if (value === undefined) {
      notes.push(`The saved ${label} could not be read; Querybara asks for it when connecting.`);
      return { ref, hasValue: false };
    }
    secrets.push([ref.id, value]);
    return { ref: { ...ref, policy: 'save' }, hasValue: true };
  };

  // Endpoint: a socket file when Navicat uses one (MySQL and MariaDB on macOS and Linux).
  const port = portOf(attrs.get('Port'), ENGINES[engine].defaultPort);
  let endpoint: ConnectionProfileInput['endpoint'] = { kind: 'host', host, port };
  if (flag(attrs, 'NamedPipe') && (engine === 'mysql' || engine === 'mariadb')) {
    const socket = attrs.get('NamedPipeSocket')?.trim() ?? '';
    if (socket.startsWith('/')) endpoint = { kind: 'socket', path: socket };
    else notes.push('Windows named pipes are not supported; the connection uses host and port.');
  }

  // Authentication.
  const user = attrs.get('UserName')?.trim() ?? '';
  const password = secret('Password', flag(attrs, 'SavePassword'), 'password');
  const needsUser = engine === 'mysql' || engine === 'mariadb' || engine === 'postgres';
  const auth: ConnectionProfileInput['auth'] =
    user !== '' || needsUser || password.hasValue
      ? {
          method: 'password',
          ...(user !== '' ? { user } : {}),
          // Without a user or a saved password, MongoDB and Redis connect without auth.
          password: password.ref,
        }
      : { method: 'none' };

  const database = attrs.get('Database')?.trim() ?? '';
  const defaultDatabase =
    database === '' || (engine === 'redis' && !/^\d+$/.test(database)) ? undefined : database;

  const profile: ConnectionProfileInput = {
    id: newId(),
    name,
    engine,
    endpoint,
    auth,
    tls: tlsOf(attrs, engine, secret),
    options: {
      ...(defaultDatabase !== undefined ? { defaultDatabase } : {}),
    },
    createdAt: now,
    updatedAt: now,
  };

  if (flag(attrs, 'SSH')) {
    const hop = sshHopOf(attrs, secret);
    if (hop) profile.ssh = { hops: [hop] };
    else notes.push('The SSH tunnel has no host or user name; it was left out.');
  }
  if (flag(attrs, 'HTTP')) notes.push('HTTP tunnels are not supported; it was left out.');

  const parsed = connectionProfileSchema.safeParse(profile);
  if (!parsed.success) {
    return { name, reason: parsed.error.issues[0]?.message ?? 'Its settings are not valid' };
  }
  return { profile: parsed.data, notes, secrets };
}

type SecretField = (
  field: string,
  saved: boolean,
  label: string,
) => { ref: SecretRef; hasValue: boolean };

function tlsOf(
  attrs: Attributes,
  engine: EngineId,
  secret: SecretField,
): NonNullable<ConnectionProfileInput['tls']> {
  if (!flag(attrs, 'SSL')) return { mode: 'disable' };
  const caPath = path(attrs, 'SSL_CACert');
  const certPath = path(attrs, 'SSL_ClientCert');
  const keyPath = path(attrs, 'SSL_ClientKey');
  let mode: TlsMode;
  if (engine === 'postgres') {
    mode = pgSslMode(attrs.get('SSL_PGSSLMode'));
  } else if (caPath !== undefined) {
    mode = flag(attrs, 'SSL_AllowInvalidHostName') ? 'verify-ca' : 'verify-full';
  } else {
    mode = 'require';
  }
  const passphrase =
    keyPath !== undefined && (attrs.get('SSL_PEMClientKeyPassword') ?? '') !== ''
      ? secret('SSL_PEMClientKeyPassword', true, 'client key passphrase')
      : undefined;
  return {
    mode,
    ...(caPath !== undefined ? { caPath } : {}),
    ...(certPath !== undefined ? { certPath } : {}),
    ...(keyPath !== undefined ? { keyPath } : {}),
    ...(passphrase?.hasValue ? { keyPassphrase: passphrase.ref } : {}),
  };
}

/** libpq's sslmode as Navicat writes it (REQUIRE, VERIFY_CA, …). */
function pgSslMode(value: string | undefined): TlsMode {
  switch ((value ?? '').trim().toUpperCase().replace('-', '_')) {
    case 'DISABLE':
    case 'ALLOW':
      return 'disable';
    case 'VERIFY_CA':
      return 'verify-ca';
    case 'VERIFY_FULL':
      return 'verify-full';
    default:
      // PREFER and REQUIRE: encrypted, the certificate unchecked.
      return 'require';
  }
}

function sshHopOf(attrs: Attributes, secret: SecretField): SshHop | undefined {
  const host = attrs.get('SSH_Host')?.trim() ?? '';
  const user = attrs.get('SSH_UserName')?.trim() ?? '';
  if (host === '' || user === '') return undefined;
  const port = portOf(attrs.get('SSH_Port'), 22);
  const method = (attrs.get('SSH_AuthenMethod') ?? 'PASSWORD').trim().toUpperCase();
  if (method === 'PUBLICKEY') {
    const keyPath = path(attrs, 'SSH_PrivateKey');
    if (keyPath === undefined) return { host, port, user, auth: { method: 'agent' } };
    const passphrase = secret(
      'SSH_Passphrase',
      flag(attrs, 'SSH_SavePassphrase'),
      'SSH passphrase',
    );
    return {
      host,
      port,
      user,
      auth: {
        method: 'privateKey',
        keyPath,
        ...(passphrase.hasValue ? { passphrase: passphrase.ref } : {}),
      },
    };
  }
  const password = secret('SSH_Password', flag(attrs, 'SSH_SavePassword'), 'SSH password');
  return { host, port, user, auth: { method: 'password', password: password.ref } };
}

function flag(attrs: Attributes, name: string): boolean {
  return (attrs.get(name) ?? '').trim().toLowerCase() === 'true';
}

function path(attrs: Attributes, name: string): string | undefined {
  const value = attrs.get(name)?.trim() ?? '';
  return value === '' ? undefined : value;
}

function portOf(value: string | undefined, fallback: number): number {
  const port = Number((value ?? '').trim());
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : fallback;
}

function stripBom(text: string): string {
  return text.startsWith('﻿') ? text.slice(1) : text;
}

/** `name="value"` pairs of one start tag, with XML character references decoded. */
function parseAttributes(source: string): Map<string, string> {
  const attrs = new Map<string, string>();
  for (const match of source.matchAll(/([A-Za-z_][\w.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attrs.set(match[1]!, decodeEntities(match[2] ?? match[3] ?? ''));
  }
  return attrs;
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, ref: string) => {
    if (ref.startsWith('#')) {
      const code = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[ref] ?? whole;
  });
}
