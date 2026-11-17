import { QuerybaraError } from '@querybara/core';
import { errorMessage, errorProp, mapNetworkError, tlsHint } from '@querybara/driver-sql-base';

import { syntaxErrorPosition } from './dialect';

/** What was happening when a mysql2 error occurred. */
export interface MysqlErrorContext {
  /** Endpoint description for connection errors ("db.example.com:3306"). */
  readonly where: string;
  /** Statement text, to locate syntax errors. */
  readonly statement?: string;
  /** This session asked the server to kill the statement. */
  readonly cancelRequested?: boolean;
  /** The error happened while connecting. */
  readonly connecting?: boolean;
}

const AUTH_ERRNOS = new Set([1045, 1698, 1251, 1130, 1862, 1820]);
const TIMEOUT_ERRNOS = new Set([3024, 1969, 1907]);
const LOST_ERRNOS = new Set([2006, 2013, 1053, 1927, 1152, 1153]);
const LOST_CODES = new Set([
  'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
  'PROTOCOL_ENQUEUE_AFTER_QUIT',
]);

/**
 * A system table in the mysql database does not have the layout this server expects: the data
 * directory came from an older server (MySQL 5.7 opened by MariaDB 10.6, say) and was never
 * upgraded. 1558 "Column count of mysql.proc is wrong ... Please use mariadb-upgrade", 1805
 * (the same, worded as corruption) and 1728 "Cannot load from mysql.proc".
 */
export const OUTDATED_SYSTEM_TABLE_ERRNOS: ReadonlySet<number> = new Set([1558, 1728, 1805]);

/**
 * ER_EVENTS_DB_ERROR: the event scheduler did not start, so no event can be read. The server was
 * started with event_scheduler=DISABLED, or found mysql.event unusable (outdated) at startup.
 */
export const EVENTS_UNAVAILABLE_ERRNO = 1577;

/**
 * True for an error that means the server cannot list routines or events in any database
 * through information_schema: its system tables were not upgraded with it, or its event
 * scheduler is disabled for good. system-tables.ts reads them from the mysql tables instead.
 */
export function isUnlistable(error: unknown): boolean {
  const errno = error instanceof QuerybaraError ? error.engineCode : undefined;
  return (
    typeof errno === 'number' &&
    (OUTDATED_SYSTEM_TABLE_ERRNOS.has(errno) || errno === EVENTS_UNAVAILABLE_ERRNO)
  );
}

const UPGRADE_HINT =
  "The server's system tables (the mysql database) were not upgraded along with the server: an administrator needs to run mariadb-upgrade (mysql_upgrade on MySQL) on the server";

/**
 * Maps anything mysql2 throws to a QuerybaraError: server errors by errno (with SQLSTATE and the
 * syntax error position), then network and TLS failures, then mysql2's own protocol errors.
 */
export function mapMysqlError(error: unknown, context: MysqlErrorContext): QuerybaraError {
  if (error instanceof QuerybaraError) return error;
  const cause = { cause: error };
  const errno = Number(errorProp(error, 'errno'));
  const code = errorProp(error, 'code');
  const sqlState = errorProp(error, 'sqlState');
  const message = errorProp(error, 'sqlMessage') ?? errorMessage(error);

  if (Number.isInteger(errno) && ((errno >= 1000 && errno < 2000) || errno >= 3000)) {
    const base = {
      message,
      engineCode: errno,
      ...(sqlState !== undefined && sqlState !== '' ? { sqlState } : {}),
    };
    if (AUTH_ERRNOS.has(errno) || (errno === 1044 && context.connecting)) {
      return new QuerybaraError(
        {
          ...base,
          code: 'AUTH_FAILED',
          hint:
            errno === 1130
              ? 'The server does not accept this user from this host; check the account host pattern'
              : errno === 1251
                ? 'The server uses an authentication plugin this client does not support'
                : 'Check the user name and password',
        },
        cause,
      );
    }
    if (errno === 1049 && context.connecting) {
      return new QuerybaraError(
        { ...base, code: 'NOT_FOUND', hint: 'Check the default database in the profile' },
        cause,
      );
    }
    if (errno === 1317) {
      return new QuerybaraError(
        {
          ...base,
          code: 'CANCELLED',
          ...(context.cancelRequested ? { message: 'Query cancelled' } : {}),
        },
        cause,
      );
    }
    if (TIMEOUT_ERRNOS.has(errno)) {
      return new QuerybaraError(
        { ...base, code: 'TIMEOUT', hint: 'The statement ran longer than the query timeout' },
        cause,
      );
    }
    if (errno === 1040 || errno === 1129 || LOST_ERRNOS.has(errno)) {
      return new QuerybaraError({ ...base, code: 'CONNECTION_FAILED' }, cause);
    }
    if (OUTDATED_SYSTEM_TABLE_ERRNOS.has(errno)) {
      return new QuerybaraError({ ...base, code: 'SQL_ERROR', hint: UPGRADE_HINT }, cause);
    }
    if (errno === EVENTS_UNAVAILABLE_ERRNO) {
      return new QuerybaraError(
        {
          ...base,
          code: 'SQL_ERROR',
          hint: "The server started with its event scheduler disabled (event_scheduler=DISABLED), or found mysql.event outdated or damaged; the server's error log says which. For outdated system tables, run mariadb-upgrade (mysql_upgrade on MySQL) and restart the server",
        },
        cause,
      );
    }
    const position =
      context.statement !== undefined ? syntaxErrorPosition(message, context.statement) : undefined;
    return new QuerybaraError(
      { ...base, code: 'SQL_ERROR', ...(position !== undefined ? { position } : {}) },
      cause,
    );
  }

  if (code === 'HANDSHAKE_NO_SSL_SUPPORT') {
    return new QuerybaraError(
      {
        code: 'TLS_FAILED',
        message: `The server at ${context.where} does not support TLS`,
        hint: "Enable TLS on the server, or set the profile's TLS mode to 'disable'",
        engineCode: code,
      },
      cause,
    );
  }
  if (code === 'HANDSHAKE_SSL_ERROR') {
    return new QuerybaraError(
      {
        code: 'TLS_FAILED',
        message: `TLS negotiation with ${context.where} failed: ${message}`,
        hint: tlsHint(message),
        engineCode: code,
      },
      cause,
    );
  }
  if (code === 'PROTOCOL_SEQUENCE_TIMEOUT' || (code === 'ETIMEDOUT' && context.connecting)) {
    return new QuerybaraError(
      {
        code: 'TIMEOUT',
        message: context.connecting ? `Timed out connecting to ${context.where}` : message,
        hint: 'Check the host, port and firewall rules, or raise the connect timeout',
        engineCode: code,
      },
      cause,
    );
  }
  if ((code !== undefined && LOST_CODES.has(code)) || LOST_ERRNOS.has(errno)) {
    return new QuerybaraError(
      {
        code: 'CONNECTION_FAILED',
        message: context.connecting
          ? `The server at ${context.where} closed the connection during login`
          : 'The connection to the server was lost',
        hint: context.connecting
          ? 'Check the TLS mode (the server may require TLS) and the server log'
          : 'Reconnect; if it keeps happening, check the server log',
        engineCode: code ?? errno,
      },
      cause,
    );
  }
  const network = mapNetworkError(error, context.where);
  if (network) return network;
  return new QuerybaraError(
    { code: context.connecting ? 'CONNECTION_FAILED' : 'INTERNAL', message },
    cause,
  );
}

/** True when mysql2 marked the error fatal: the connection cannot be used any more. */
export function isFatal(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'fatal' in error && error.fatal === true;
}
