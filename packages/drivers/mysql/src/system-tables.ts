import type { Row } from '@querybara/driver-sql-base';

import type { QueryFn } from './introspect';

/**
 * Routines and events read from the mysql database's own tables, for a server whose
 * information_schema cannot list them: a MySQL 5.7 data directory opened by MariaDB 10.6 without
 * mariadb-upgrade keeps a 20-column mysql.proc (error 1558) and starts with its event scheduler
 * disabled (error 1577). SHOW CREATE fails there too, so definitions are rebuilt as the server
 * writes them: MariaDB's Sp_handler::show_create_sp and Event_timed::get_create_event, which
 * MySQL shares. The columns read here are the same from MySQL 5.1 to MariaDB 11.
 *
 * Rows carry the aliases of the information_schema queries they stand in for, plus the rebuilt
 * `definition`. Reading these tables takes SELECT on mysql.proc and mysql.event.
 */

/** TextDecoder labels for the character sets a routine's text may be stored in. */
const DECODERS: Readonly<Record<string, string>> = {
  latin1: 'windows-1252',
  latin2: 'iso-8859-2',
  latin5: 'iso-8859-9',
  latin7: 'iso-8859-13',
  greek: 'iso-8859-7',
  hebrew: 'iso-8859-8',
  cp1250: 'windows-1250',
  cp1251: 'windows-1251',
  cp1256: 'windows-1256',
  cp1257: 'windows-1257',
  koi8r: 'koi8-r',
  koi8u: 'koi8-u',
  sjis: 'shift_jis',
  cp932: 'shift_jis',
  ujis: 'euc-jp',
  eucjpms: 'euc-jp',
  euckr: 'euc-kr',
  gbk: 'gbk',
  gb2312: 'gbk',
  gb18030: 'gb18030',
  big5: 'big5',
};

/**
 * A routine's parameter list, return type and body are stored as bytes in the client character
 * set they were created under.
 */
export function decodeStored(value: unknown, charset: string | undefined): string {
  if (value === null || value === undefined) return '';
  if (!(value instanceof Uint8Array)) return String(value);
  const label = DECODERS[(charset ?? '').toLowerCase()] ?? 'utf-8';
  return new TextDecoder(label).decode(value);
}

/** `name` as the server quotes an identifier. */
function identifier(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

/** "user@host" → DEFINER=`user`@`host` (a role has no host). */
function definerClause(definer: string): string {
  const at = definer.lastIndexOf('@');
  if (at < 0) return `DEFINER=${identifier(definer)} `;
  return `DEFINER=${identifier(definer.slice(0, at))}@${identifier(definer.slice(at + 1))} `;
}

/** The characters append_unescaped escapes, and how. */
const ESCAPES: ReadonlyMap<string, string> = new Map([
  ['\\', '\\\\'],
  ["'", "\\'"],
  ['\n', '\\n'],
  ['\r', '\\r'],
  ['\u0000', '\\0'],
  ['\u001a', '\\Z'],
]);

/** A string literal as the server's append_unescaped writes it. */
function literal(text: string): string {
  let escaped = '';
  for (const c of text) escaped += ESCAPES.get(c) ?? c;
  return `'${escaped}'`;
}

function text(row: Row, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  return value instanceof Uint8Array ? decodeStored(value, 'utf8') : String(value);
}

/** SHOW CREATE PROCEDURE / FUNCTION, rebuilt from a mysql.proc row. */
export function createRoutine(row: Row): string {
  const charset = text(row, 'charset');
  const type = text(row, 'type') === 'FUNCTION' ? 'FUNCTION' : 'PROCEDURE';
  let out = `CREATE ${definerClause(text(row, 'definer') ?? '')}${type} ${identifier(text(row, 'name') ?? '')}(${decodeStored(row['params'], charset)})`;
  if (type === 'FUNCTION') out += ` RETURNS ${decodeStored(row['returns_raw'], charset)}`;
  out += '\n';
  const access = text(row, 'sql_data_access');
  if (access === 'NO_SQL') out += '    NO SQL\n';
  else if (access === 'READS_SQL_DATA') out += '    READS SQL DATA\n';
  else if (access === 'MODIFIES_SQL_DATA') out += '    MODIFIES SQL DATA\n';
  if (text(row, 'is_deterministic') === 'YES') out += '    DETERMINISTIC\n';
  if (text(row, 'security_type') === 'INVOKER') out += '    SQL SECURITY INVOKER\n';
  const comment = text(row, 'comment') ?? '';
  if (comment !== '') out += `    COMMENT ${literal(comment)}\n`;
  return out + decodeStored(row['body'], charset);
}

/**
 * mysql.proc rows in information_schema.ROUTINES' shape: name, type, returns, definer, comment,
 * created, modified, sql_mode, and the rebuilt definition.
 */
export async function readProcTable(
  query: QueryFn,
  db: string,
  type?: 'PROCEDURE' | 'FUNCTION',
): Promise<Row[]> {
  const rows = await query(
    `SELECT name, type, definer, comment, created, modified, sql_mode,
       param_list AS params, \`returns\` AS returns_raw, body,
       sql_data_access, is_deterministic, security_type, character_set_client AS charset
     FROM mysql.proc
     WHERE db = ? AND type IN ('FUNCTION', 'PROCEDURE')${type !== undefined ? ' AND type = ?' : ''}
     ORDER BY name`,
    type !== undefined ? [db, type] : [db],
  );
  return rows.map((row) => ({
    name: text(row, 'name') ?? '',
    type: text(row, 'type') ?? 'PROCEDURE',
    returns:
      text(row, 'type') === 'FUNCTION'
        ? decodeStored(row['returns_raw'], text(row, 'charset'))
        : null,
    definer: text(row, 'definer') ?? null,
    comment: text(row, 'comment') ?? '',
    created: text(row, 'created') ?? null,
    modified: text(row, 'modified') ?? null,
    sql_mode: text(row, 'sql_mode') ?? null,
    definition: createRoutine(row),
  }));
}

/**
 * An event's interval as the server writes it: mysql.event keeps a composite interval in its
 * smallest unit ('1 6' DAY_HOUR is 30), a WEEK in days and a QUARTER in months
 * (Events::reconstruct_interval_expression).
 */
export function intervalExpression(value: number, field: string): string {
  const quoted = (parts: number[], separators: string[]): string =>
    `'${parts.map((p, i) => (i === 0 ? '' : separators[i - 1]) + String(p)).join('')}'`;
  switch (field) {
    case 'YEAR_MONTH':
      return quoted([Math.floor(value / 12), value % 12], ['-']);
    case 'DAY_HOUR':
      return quoted([Math.floor(value / 24), value % 24], [' ']);
    case 'HOUR_MINUTE':
    case 'MINUTE_SECOND':
      return quoted([Math.floor(value / 60), value % 60], [':']);
    case 'DAY_MINUTE': {
      const days = Math.floor(value / 1440);
      const left = value - days * 1440;
      return quoted([days, Math.floor(left / 60), left % 60], [' ', ':']);
    }
    case 'HOUR_SECOND': {
      const hours = Math.floor(value / 3600);
      const left = value - hours * 3600;
      return quoted([hours, Math.floor(left / 60), left % 60], [':', ':']);
    }
    case 'DAY_SECOND': {
      const days = Math.floor(value / 86400);
      let left = value - days * 86400;
      const hours = Math.floor(left / 3600);
      left -= hours * 3600;
      return quoted([days, hours, Math.floor(left / 60), left % 60], [' ', ':', ':']);
    }
    case 'QUARTER':
      return String(Math.floor(value / 3));
    case 'WEEK':
      return String(Math.floor(value / 7));
    default:
      return String(value);
  }
}

/** SHOW CREATE EVENT, rebuilt from a mysql.event row whose times are in the event's zone. */
export function createEvent(row: Row): string {
  let out = `CREATE ${definerClause(text(row, 'definer') ?? '')}EVENT ${identifier(text(row, 'name') ?? '')}`;
  const field = text(row, 'unit');
  const value = text(row, 'interval_raw');
  if (field !== undefined && value !== undefined) {
    out += ` ON SCHEDULE EVERY ${intervalExpression(Number(value), field)} ${field}`;
    const starts = text(row, 'starts');
    if (starts !== undefined) out += ` STARTS '${starts}'`;
    const ends = text(row, 'ends');
    if (ends !== undefined) out += ` ENDS '${ends}'`;
  } else {
    out += ` ON SCHEDULE AT '${text(row, 'execute_at') ?? ''}'`;
  }
  out +=
    text(row, 'on_completion') === 'DROP'
      ? ' ON COMPLETION NOT PRESERVE '
      : ' ON COMPLETION PRESERVE ';
  const status = text(row, 'status');
  out +=
    status === 'ENABLED'
      ? 'ENABLE'
      : status === 'SLAVESIDE_DISABLED'
        ? 'DISABLE ON SLAVE'
        : 'DISABLE';
  const comment = text(row, 'comment') ?? '';
  if (comment !== '') out += ` COMMENT ${literal(comment)}`;
  return `${out} DO ${decodeStored(row['body'], text(row, 'charset'))}`;
}

/**
 * mysql.event rows in information_schema.EVENTS' shape: name, status, type, every, unit,
 * execute_at, last_executed, comment, sql_mode, and the rebuilt definition. mysql.event keeps
 * times in UTC; they are given in the event's own time zone, as the server shows them. When
 * that zone cannot be converted to (a named zone without time zone tables), `definition` is
 * null and the times stay in UTC.
 */
export async function readEventTable(query: QueryFn, db: string): Promise<Row[]> {
  const local = (column: string): string =>
    `DATE_FORMAT(COALESCE(CONVERT_TZ(${column}, '+00:00', time_zone), ${column}), '%Y-%m-%d %H:%i:%s')`;
  const rows = await query(
    `SELECT name, definer, status, on_completion, comment, sql_mode, body,
       character_set_client AS charset, interval_value AS interval_raw, interval_field AS unit,
       ${local('execute_at')} AS execute_at, ${local('starts')} AS starts,
       ${local('ends')} AS ends, ${local('last_executed')} AS last_executed,
       CONVERT_TZ('2000-01-01 00:00:00', '+00:00', time_zone) IS NOT NULL AS zoned
     FROM mysql.event WHERE db = ? ORDER BY name`,
    [db],
  );
  return rows.map((row) => {
    const unit = text(row, 'unit');
    const raw = text(row, 'interval_raw');
    return {
      name: text(row, 'name') ?? '',
      status: text(row, 'status') ?? null,
      type: unit !== undefined ? 'RECURRING' : 'ONE TIME',
      every: unit !== undefined && raw !== undefined ? intervalExpression(Number(raw), unit) : null,
      unit: unit ?? null,
      execute_at: text(row, 'execute_at') ?? null,
      last_executed: text(row, 'last_executed') ?? null,
      comment: text(row, 'comment') ?? '',
      sql_mode: text(row, 'sql_mode') ?? null,
      definition: Number(row['zoned']) === 1 ? createEvent(row) : null,
    };
  });
}
