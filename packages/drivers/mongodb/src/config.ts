import { isIP } from 'node:net';

import { ENGINES, QuerybaraError, type HostPort, type ResolvedProfile } from '@querybara/core';
import {
  assertSupportedNetwork,
  buildTlsSettings,
  type FileReader,
  type TlsSettings,
} from '@querybara/driver-sql-base';
import { nodeRouteOf, tunnelReach } from '@querybara/tunnel';
import type { AuthMechanism, MongoClientOptions } from 'mongodb';

/** Everything needed to open a MongoClient for a profile. */
export interface MongoClientPlan {
  /** The connection string, without credentials (they go in `options.auth`). */
  readonly url: string;
  readonly options: MongoClientOptions;
  readonly tls: TlsSettings;
  /** The seed hosts, or the SRV name, for messages and Test Connection. */
  readonly seeds: readonly HostPort[];
  readonly srv: boolean;
  /** "host:port[, host:port]" (never credentials), for messages. */
  readonly where: string;
  /** The session's initial database: the profile's default, the URI's, else "test". */
  readonly defaultDatabase: string;
  /** Through an SSH tunnel or proxy (endpointOverride, and `routed` for several servers). */
  readonly tunnelled: boolean;
  /**
   * Every server reached through the tunnel's SOCKS5 endpoint (a host list, SRV name or replica
   * set URI behind a tunnel or proxy); otherwise a tunnel reaches one host, connected directly.
   */
  readonly routed: boolean;
  /** The replica set name the profile asks for, if any. */
  readonly replicaSet?: string;
  /**
   * MONGODB-OIDC signed in through the browser: connectMongoClient adds the sign-in
   * (OIDC_HUMAN_CALLBACK), which needs a browser and keeps the tokens between connections.
   */
  readonly browserSignIn: boolean;
  /** Secret values that must never appear in messages. */
  readonly secrets: readonly string[];
}

/** The parts of a `mongodb://` or `mongodb+srv://` URI. */
export interface MongoUriParts {
  readonly srv: boolean;
  readonly user?: string;
  readonly password?: string;
  /** Comma-separated host list as written. */
  readonly hosts: string;
  readonly database?: string;
  /** The query string without "?". */
  readonly query: string;
}

function invalidUri(reason: string): QuerybaraError {
  // The URI itself is never quoted: it may hold a password.
  return new QuerybaraError({
    code: 'VALIDATION_FAILED',
    message: `The MongoDB connection string is not valid: ${reason}`,
    hint: 'Use the form mongodb://host:port/database?options or mongodb+srv://cluster.example.net',
  });
}

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    throw invalidUri('it contains a malformed percent-escape');
  }
}

/** Splits a MongoDB connection string into credentials, hosts, database and options. */
export function splitMongoUri(uri: string): MongoUriParts {
  const trimmed = uri.trim();
  const match = /^(mongodb(?:\+srv)?):\/\//i.exec(trimmed);
  if (!match) throw invalidUri('it must start with mongodb:// or mongodb+srv://');
  const rest = trimmed.slice(match[0].length);
  const authorityEnd = rest.search(/[/?]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  const tail = authorityEnd === -1 ? '' : rest.slice(authorityEnd);
  const at = authority.lastIndexOf('@');
  const userinfo = at === -1 ? undefined : authority.slice(0, at);
  const hosts = at === -1 ? authority : authority.slice(at + 1);
  if (hosts === '') throw invalidUri('it names no host');
  const queryStart = tail.indexOf('?');
  const path = (queryStart === -1 ? tail : tail.slice(0, queryStart)).replace(/^\//, '');
  const query = queryStart === -1 ? '' : tail.slice(queryStart + 1);
  const parts: { -readonly [K in keyof MongoUriParts]: MongoUriParts[K] } = {
    srv: match[1]!.toLowerCase() === 'mongodb+srv',
    hosts,
    query,
  };
  if (userinfo !== undefined) {
    const colon = userinfo.indexOf(':');
    const user = colon === -1 ? userinfo : userinfo.slice(0, colon);
    if (user !== '') parts.user = decode(user);
    if (colon !== -1) parts.password = decode(userinfo.slice(colon + 1));
  }
  if (path !== '') parts.database = decode(path);
  return parts;
}

/** Parses "a:1,b,[::1]:3" into host/port pairs (the default port when none is given). */
export function parseHostList(
  hosts: string,
  defaultPort = ENGINES.mongodb.defaultPort,
): HostPort[] {
  return hosts.split(',').map((entry) => {
    const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(entry);
    if (bracketed) {
      return { host: bracketed[1]!, port: bracketed[2] ? Number(bracketed[2]) : defaultPort };
    }
    const colon = entry.lastIndexOf(':');
    if (colon !== -1 && entry.indexOf(':') === colon) {
      const port = Number(entry.slice(colon + 1));
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw invalidUri(`"${entry.slice(0, colon)}" has an invalid port`);
      }
      return { host: decode(entry.slice(0, colon)), port };
    }
    return { host: decode(entry), port: defaultPort };
  });
}

/** "host:port" with IPv6 hosts bracketed. */
export function hostPortText({ host, port }: HostPort): string {
  return `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
}

function queryParams(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

const PASSWORD_MECHANISMS: Readonly<Record<string, AuthMechanism>> = {
  DEFAULT: 'DEFAULT',
  'SCRAM-SHA-1': 'SCRAM-SHA-1',
  'SCRAM-SHA-256': 'SCRAM-SHA-256',
  PLAIN: 'PLAIN',
  LDAP: 'PLAIN',
  'MONGODB-AWS': 'MONGODB-AWS',
  'MONGODB-OIDC': 'MONGODB-OIDC',
};

/** The hosts the driver lets an OIDC sign-in send its token to (its own DEFAULT_ALLOWED_HOSTS). */
const OIDC_DEFAULT_HOSTS = [
  '*.mongodb.net',
  '*.mongodb-qa.net',
  '*.mongodb-dev.net',
  '*.mongodbgov.net',
  'localhost',
  '127.0.0.1',
  '::1',
];

/**
 * Builds the MongoClient connection string and options for a resolved profile (spec §4):
 *
 * - Endpoints: `host`, `hosts` (+ replica set), `srv` (mongodb+srv) and `uri` (credentials are
 *   taken out of the string and passed as options).
 * - Tunnels (ADR 0008): a single host behind an SSH tunnel or proxy (`endpointOverride` alone)
 *   is connected to through the forward with `directConnection: true`. A host list, SRV name
 *   or replica set URI behind one comes with a node route (`nodeRouteOf`): the client keeps the
 *   profile's own seeds and sends every connection through the route's SOCKS5 endpoint
 *   (`proxyHost`...), so it discovers the members and reaches them by the names they
 *   announce, resolved on the far side. SRV and TXT records are still looked up locally.
 * - Auth: `none`; `password` with SCRAM-SHA-1/256 (or LDAP as PLAIN in `$external`) from
 *   `mechanism`; MONGODB-AWS with an access key (user) and secret key (password), or the AWS
 *   SDK's credential chain without them; MONGODB-OIDC from a workload's identity
 *   (`oidcEnvironment`) or a sign-in in the browser; `clientCertificate` as MONGODB-X509 from
 *   the TLS certificate.
 * - TLS: disable → no TLS; require → tlsAllowInvalidCertificates; verify-ca →
 *   tlsAllowInvalidHostnames; verify-full → full checks (pinned to the profile host name when
 *   tunnelled or when a server name override is set). CA, client certificate, key and key
 *   passphrase come from the profile; secrets only from `resolved.secrets`.
 * - Options: authSource, directConnection, readPreference, connect timeout (also the server
 *   selection timeout, so a dead server fails as fast as a refused one), idle timeout,
 *   application name and default database.
 */
export function buildMongoClientPlan(
  resolved: ResolvedProfile,
  opts: { readonly readFile?: FileReader } = {},
): MongoClientPlan {
  const { profile } = resolved;
  if (profile.engine !== 'mongodb') {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: `The MongoDB adapter cannot open a ${ENGINES[profile.engine].displayName} profile`,
    });
  }
  assertSupportedNetwork(resolved);
  // Behind a tunnel: one forwarded host, or every member through the node route.
  const reach = resolved.endpointOverride ? tunnelReach(profile) : undefined;
  const route = reach?.kind === 'nodes' ? nodeRouteOf(resolved) : undefined;
  if (reach?.kind === 'nodes' && !route) {
    throw new QuerybaraError({
      code: 'NOT_SUPPORTED',
      message:
        'This profile reaches several MongoDB servers through its tunnel, but only one forwarded host was given',
      hint: 'Open it through the connection host, which reaches every member through the tunnel (see connectThroughTransport)',
    });
  }
  const override = reach?.kind === 'host' ? resolved.endpointOverride : undefined;
  const tunnelledTo = reach?.kind === 'host' ? reach.target : undefined;
  const options = profile.options;
  const endpoint = profile.endpoint;
  const secrets = Object.values(resolved.secrets).filter((value) => value.length > 0);

  let seeds: HostPort[];
  let srv = false;
  let uriParts: MongoUriParts | undefined;
  let replicaSet: string | undefined;
  switch (endpoint.kind) {
    case 'host':
      seeds = [{ host: endpoint.host, port: endpoint.port }];
      break;
    case 'hosts':
      seeds = endpoint.hosts.map((h) => ({ host: h.host, port: h.port }));
      replicaSet = endpoint.replicaSet;
      break;
    case 'srv':
      seeds = [{ host: endpoint.host, port: ENGINES.mongodb.defaultPort }];
      srv = true;
      break;
    case 'uri':
      uriParts = splitMongoUri(endpoint.uri);
      srv = uriParts.srv;
      seeds = srv
        ? [{ host: uriParts.hosts, port: ENGINES.mongodb.defaultPort }]
        : parseHostList(uriParts.hosts);
      replicaSet = queryParams(uriParts.query).get('replicaSet') ?? undefined;
      if (uriParts.password !== undefined) secrets.push(uriParts.password);
      break;
    default:
      throw new QuerybaraError({
        code: 'NOT_SUPPORTED',
        message: `MongoDB does not accept a "${endpoint.kind}" endpoint`,
        hint: 'Use a host, a host list, an SRV name or a mongodb:// connection string',
      });
  }

  const database = options.defaultDatabase ?? uriParts?.database ?? 'test';
  const path = uriParts?.database !== undefined ? `/${encodeURIComponent(uriParts.database)}` : '/';
  const query = uriParts?.query ? `?${uriParts.query}` : '';
  let url: string;
  if (override) {
    url = `mongodb://${hostPortText(override)}${path}${query}`;
  } else if (srv) {
    url = `mongodb+srv://${uriParts?.hosts ?? seeds[0]!.host}${path}${query}`;
  } else {
    url = `mongodb://${seeds.map(hostPortText).join(',')}${path}${query}`;
  }

  const client: MongoClientOptions = {
    appName: options.applicationName,
    connectTimeoutMS: options.connectTimeoutMs,
    serverSelectionTimeoutMS: options.connectTimeoutMs,
    maxPoolSize: 10,
    monitorCommands: false,
  };
  if (options.idleTimeoutMs !== undefined) client.maxIdleTimeMS = options.idleTimeoutMs;
  if (replicaSet !== undefined && endpoint.kind === 'hosts') client.replicaSet = replicaSet;
  if (override) client.directConnection = true;
  else if (options.directConnection !== undefined)
    client.directConnection = options.directConnection;
  if (route) {
    // The driver opens every connection (monitoring and pool, to each member) through here.
    const socks = route.socks5;
    client.proxyHost = socks.host;
    client.proxyPort = socks.port;
    client.proxyUsername = socks.user;
    client.proxyPassword = socks.password;
    secrets.push(socks.password);
  }
  if (options.readPreference !== undefined) client.readPreference = options.readPreference;

  const tlsHost = tunnelledTo?.host ?? seeds[0]!.host;
  const tls = buildTlsSettings(
    resolved,
    {
      kind: 'tcp',
      host: override?.host ?? seeds[0]!.host,
      port: override?.port ?? seeds[0]!.port,
      tlsHost,
    },
    opts.readFile,
  );
  Object.assign(
    client,
    tlsOptions(tls, profile.tls.servername !== undefined || override !== undefined),
  );
  const auth = authOptions(resolved, uriParts);
  const browserSignIn =
    auth.authMechanism === 'MONGODB-OIDC' &&
    auth.authMechanismProperties?.ENVIRONMENT === undefined;
  if (browserSignIn) {
    // The sign-in sends its token only to these: the driver's own list and the profile's hosts.
    auth.authMechanismProperties = {
      ...auth.authMechanismProperties,
      ALLOWED_HOSTS: oidcAllowedHosts(seeds, srv),
    };
  }
  Object.assign(client, auth);

  const named = srv
    ? `${uriParts?.hosts ?? seeds[0]!.host} (SRV)`
    : seeds.map(hostPortText).join(', ');
  const where = override
    ? `${hostPortText(override)} (tunnel to ${hostPortText(tunnelledTo!)})`
    : route
      ? `${named} through the tunnel`
      : named;
  return {
    url,
    options: client,
    tls,
    seeds,
    srv,
    where,
    defaultDatabase: database,
    tunnelled: override !== undefined || route !== undefined,
    routed: route !== undefined,
    ...(replicaSet !== undefined ? { replicaSet } : {}),
    browserSignIn,
    secrets,
  };
}

/**
 * The hosts an OIDC sign-in may send its token to: the driver's defaults, the profile's own
 * hosts, and for an SRV name the hosts of its domain (where SRV records must point).
 */
export function oidcAllowedHosts(seeds: readonly HostPort[], srv: boolean): string[] {
  const hosts = new Set(OIDC_DEFAULT_HOSTS);
  for (const { host } of seeds) {
    hosts.add(host);
    if (srv) {
      const domain = host.split('.').slice(1).join('.');
      if (domain.includes('.')) hosts.add(`*.${domain}`);
    }
  }
  return [...hosts];
}

/**
 * The driver's TLS options for a TLS mode. `pinned` keeps buildTlsSettings' server name and
 * identity check (the profile host behind a tunnel, or an explicit override); otherwise each
 * member's certificate is checked against its own host name, which a host list or SRV needs.
 */
export function tlsOptions(tls: TlsSettings, pinned: boolean): MongoClientOptions {
  if (tls.mode === 'disable' || !tls.options) return { tls: false };
  const source = tls.options;
  const out: MongoClientOptions = { tls: true };
  if (source.ca !== undefined) out.ca = source.ca;
  if (source.cert !== undefined) out.cert = source.cert;
  if (source.key !== undefined) out.key = source.key;
  if (source.passphrase !== undefined) out.passphrase = source.passphrase;
  switch (tls.mode) {
    case 'require':
      out.tlsAllowInvalidCertificates = true;
      break;
    case 'verify-ca':
      out.tlsAllowInvalidHostnames = true;
      break;
    case 'verify-full':
      if (pinned) {
        if (source.servername !== undefined) out.servername = source.servername;
        if (source.checkServerIdentity !== undefined) {
          out.checkServerIdentity = source.checkServerIdentity;
        }
      }
      break;
  }
  return out;
}

/** The driver's auth options for the profile's auth method (see buildMongoClientPlan). */
export function authOptions(
  resolved: ResolvedProfile,
  uri?: Pick<MongoUriParts, 'user' | 'password' | 'query'>,
): MongoClientOptions {
  const { auth, tls, options } = resolved.profile;
  const withSource = (defaultSource?: string): MongoClientOptions => {
    const source = options.authSource ?? defaultSource;
    return source !== undefined ? { authSource: source } : {};
  };
  switch (auth.method) {
    case 'none': {
      // A connection string may name a mechanism that takes no password of the profile's.
      const named = uriMechanism(uri?.query);
      if (named === 'MONGODB-AWS') return awsOptions(uri?.user, uri?.password);
      if (named === 'MONGODB-OIDC')
        return oidcOptions(uri?.user, uri?.password, options, uri?.query);
      return {};
    }
    case 'password': {
      const user = auth.user ?? uri?.user;
      let password: string | undefined;
      if (auth.password) {
        password = resolved.secrets[auth.password.id];
        if (password === undefined) {
          throw new QuerybaraError({
            code: 'AUTH_FAILED',
            message: 'The password for this connection was not provided',
            hint: 'Enter the password, or save it in the profile',
          });
        }
      } else {
        password = uri?.password;
      }
      const requested = auth.mechanism?.trim().toUpperCase();
      const mechanism =
        requested === undefined || requested === '' ? undefined : PASSWORD_MECHANISMS[requested];
      if (requested && mechanism === undefined) {
        throw new QuerybaraError({
          code: 'NOT_SUPPORTED',
          message: `The authentication mechanism "${auth.mechanism}" is not supported`,
          hint: 'Use SCRAM-SHA-256, SCRAM-SHA-1, PLAIN for LDAP, MONGODB-AWS or MONGODB-OIDC',
        });
      }
      // A connection string may name the mechanism itself.
      const named = mechanism ?? uriMechanism(uri?.query);
      if (named === 'MONGODB-AWS') return awsOptions(user, password);
      if (named === 'MONGODB-OIDC') return oidcOptions(user, password, options, uri?.query);
      if (user === undefined) return withSource();
      const out: MongoClientOptions = {
        auth: credentials(user, password),
        ...withSource(mechanism === 'PLAIN' ? '$external' : undefined),
      };
      if (mechanism !== undefined && mechanism !== 'DEFAULT') out.authMechanism = mechanism;
      return out;
    }
    case 'clientCertificate': {
      if (tls.mode === 'disable' || !tls.certPath) {
        throw new QuerybaraError({
          code: 'VALIDATION_FAILED',
          message: 'X.509 authentication needs TLS with a client certificate',
          hint: 'Turn TLS on and set the client certificate (and key) file',
        });
      }
      const user = auth.user ?? uri?.user;
      return {
        authMechanism: 'MONGODB-X509',
        authSource: '$external',
        ...(user !== undefined ? { auth: credentials(user) } : {}),
      };
    }
    case 'apiKey':
    case 'bearer':
      throw new QuerybaraError({
        code: 'NOT_SUPPORTED',
        message: `"${auth.method}" authentication does not apply to MongoDB`,
        hint: 'Use password (SCRAM or LDAP) or X.509 authentication',
      });
  }
}

/** The driver's `auth`, which must hold a `password` key even when there is none. */
function credentials(user: string, password?: string): NonNullable<MongoClientOptions['auth']> {
  return { username: user, password };
}

/** The `authMechanism` a connection string's options name, if any. */
function uriMechanism(query: string | undefined): string | undefined {
  if (query === undefined || query === '') return undefined;
  return queryParams(query).get('authMechanism')?.toUpperCase() ?? undefined;
}

/**
 * MONGODB-AWS: an access key ID (the user) and secret access key (the password), or without
 * them the AWS SDK's credential chain (environment, shared files and SSO, the instance's role).
 * The driver takes credentials only from a provider, so explicit keys become one.
 */
function awsOptions(user: string | undefined, secret: string | undefined): MongoClientOptions {
  const out: MongoClientOptions = { authMechanism: 'MONGODB-AWS', authSource: '$external' };
  if (user === undefined) return out;
  if (secret === undefined) {
    throw new QuerybaraError({
      code: 'AUTH_FAILED',
      message: 'The secret access key for this AWS access key ID was not provided',
      hint: 'Enter the secret access key as the password, or clear the user to use the AWS credential chain',
    });
  }
  out.authMechanismProperties = {
    AWS_CREDENTIAL_PROVIDER: () => Promise.resolve({ accessKeyId: user, secretAccessKey: secret }),
  };
  return out;
}

/**
 * MONGODB-OIDC: from a workload's identity (Azure, GCP, Kubernetes; Azure's managed identity may
 * be named by the user), else a sign-in in the browser, which connectMongoClient adds.
 */
function oidcOptions(
  user: string | undefined,
  password: string | undefined,
  options: ResolvedProfile['profile']['options'],
  query: string | undefined,
): MongoClientOptions {
  if (password !== undefined && password !== '') {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: 'OIDC authentication takes no password',
      hint: 'Clear the password: the identity provider signs you in',
    });
  }
  const environment = options.oidcEnvironment ?? oidcEnvironmentOf(query);
  const out: MongoClientOptions = { authMechanism: 'MONGODB-OIDC', authSource: '$external' };
  if (environment === undefined) {
    if (user !== undefined) out.auth = credentials(user);
    out.authMechanismProperties = {};
    return out;
  }
  const resource = options.oidcAudience ?? uriMechanismProperty(query, 'TOKEN_RESOURCE');
  if ((environment === 'azure' || environment === 'gcp') && resource === undefined) {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: `OIDC on ${environment === 'azure' ? 'Azure' : 'GCP'} needs the token's audience`,
      hint: 'Set the token resource, e.g. api://<application id> on Azure',
    });
  }
  out.authMechanismProperties = {
    ENVIRONMENT: environment,
    ...(resource !== undefined ? { TOKEN_RESOURCE: resource } : {}),
  };
  if (user !== undefined && environment === 'azure') out.auth = credentials(user);
  return out;
}

const OIDC_ENVIRONMENTS = ['azure', 'gcp', 'k8s', 'test'] as const;

/** The workload a connection string's OIDC properties name (ENVIRONMENT), if any. */
function oidcEnvironmentOf(
  query: string | undefined,
): (typeof OIDC_ENVIRONMENTS)[number] | undefined {
  const named = uriMechanismProperty(query, 'ENVIRONMENT');
  if (named === undefined) return undefined;
  const known = OIDC_ENVIRONMENTS.find((environment) => environment === named);
  if (known === undefined) {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: `The OIDC environment "${named}" is not known`,
      hint: 'Use ENVIRONMENT:azure, gcp or k8s',
    });
  }
  return known;
}

/** One of a connection string's `authMechanismProperties` (KEY:value pairs, comma-separated). */
function uriMechanismProperty(query: string | undefined, key: string): string | undefined {
  if (query === undefined || query === '') return undefined;
  for (const pair of (queryParams(query).get('authMechanismProperties') ?? '').split(',')) {
    const colon = pair.indexOf(':');
    if (colon !== -1 && pair.slice(0, colon) === key) return pair.slice(colon + 1);
  }
  return undefined;
}

/**
 * Removes credentials and secret values from a message: the user info of any MongoDB URI,
 * secret-bearing URI options, and every secret the profile holds (short ones only where they
 * stand alone, so a two-letter password does not blank out every word).
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text
    .replace(/(mongodb(?:\+srv)?:\/\/)[^@/\s]*@/gi, '$1<credentials>@')
    .replace(/((?:tlsCertificateKeyFilePassword|sslPEMKeyPassword)[=:])[^&,\s]*/gi, '$1***')
    // Mechanism properties can carry a session token among other key:value pairs.
    .replace(/(authMechanismProperties=)[^&\s]*/gi, '$1***');
  for (const secret of secrets) {
    if (secret.length >= 4) {
      out = out.split(secret).join('***');
    } else if (secret.length > 0) {
      const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'gu'), '***');
    }
  }
  return out;
}
