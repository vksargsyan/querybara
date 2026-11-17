import { describe, expect, it } from 'vitest';

import { createEvent, createRoutine, decodeStored, intervalExpression } from '../src/system-tables';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('rebuilding SHOW CREATE from the mysql tables', () => {
  it('writes a procedure as the server does: definer, characteristics, body', () => {
    expect(
      createRoutine({
        name: 'odd `name`',
        type: 'PROCEDURE',
        definer: 'app@%',
        comment: 'line\nbreak',
        params: bytes('OUT c INT'),
        returns_raw: bytes(''),
        body: bytes('SELECT COUNT(*) INTO c FROM users'),
        sql_data_access: 'READS_SQL_DATA',
        is_deterministic: 'NO',
        security_type: 'INVOKER',
        charset: 'utf8mb4',
      }),
    ).toBe(
      "CREATE DEFINER=`app`@`%` PROCEDURE `odd ``name```(OUT c INT)\n    READS SQL DATA\n    SQL SECURITY INVOKER\n    COMMENT 'line\\nbreak'\nSELECT COUNT(*) INTO c FROM users",
    );
  });

  it('leaves out the defaults (CONTAINS SQL, NOT DETERMINISTIC, SQL SECURITY DEFINER)', () => {
    expect(
      createRoutine({
        name: 'add_user',
        type: 'PROCEDURE',
        definer: 'admin',
        comment: '',
        params: bytes('IN n VARCHAR(50)'),
        body: bytes('BEGIN INSERT INTO users(name) VALUES (n); END'),
        sql_data_access: 'CONTAINS_SQL',
        is_deterministic: 'NO',
        security_type: 'DEFINER',
        charset: 'utf8',
      }),
    ).toBe(
      'CREATE DEFINER=`admin` PROCEDURE `add_user`(IN n VARCHAR(50))\nBEGIN INSERT INTO users(name) VALUES (n); END',
    );
  });

  it('decodes routine text in the client character set it was stored in', () => {
    expect(decodeStored(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]), 'latin1')).toBe('café');
    expect(decodeStored(Uint8Array.from([0xc3, 0xa9]), 'utf8mb4')).toBe('é');
    expect(decodeStored(Uint8Array.from([0xe9]), 'cp1251')).toBe('й');
    expect(decodeStored(null, 'latin1')).toBe('');
  });

  it.each([
    [1, 'DAY', '1'],
    [14, 'WEEK', '2'],
    [6, 'QUARTER', '2'],
    [14, 'YEAR_MONTH', "'1-2'"],
    [30, 'DAY_HOUR', "'1 6'"],
    [90, 'HOUR_MINUTE', "'1:30'"],
    [75, 'MINUTE_SECOND', "'1:15'"],
    [1530, 'DAY_MINUTE', "'1 1:30'"],
    [3725, 'HOUR_SECOND', "'1:2:5'"],
    [90125, 'DAY_SECOND', "'1 1:2:5'"],
  ])('writes %i %s as %s', (value, field, expected) => {
    expect(intervalExpression(value, field)).toBe(expected);
  });

  it('writes recurring and one-off events as the server does', () => {
    const base = {
      name: 'e',
      definer: 'root@localhost',
      comment: '',
      body: bytes('DO_SOMETHING()'),
      charset: 'utf8mb4',
    };
    expect(
      createEvent({
        ...base,
        status: 'ENABLED',
        on_completion: 'DROP',
        interval_raw: 2,
        unit: 'HOUR',
        starts: '2026-06-01 10:00:00',
        ends: '2027-06-01 10:00:00',
      }),
    ).toBe(
      "CREATE DEFINER=`root`@`localhost` EVENT `e` ON SCHEDULE EVERY 2 HOUR STARTS '2026-06-01 10:00:00' ENDS '2027-06-01 10:00:00' ON COMPLETION NOT PRESERVE ENABLE DO DO_SOMETHING()",
    );
    expect(
      createEvent({
        ...base,
        status: 'SLAVESIDE_DISABLED',
        on_completion: 'PRESERVE',
        interval_raw: null,
        unit: null,
        execute_at: '2030-05-01 12:00:00',
      }),
    ).toBe(
      "CREATE DEFINER=`root`@`localhost` EVENT `e` ON SCHEDULE AT '2030-05-01 12:00:00' ON COMPLETION PRESERVE DISABLE ON SLAVE DO DO_SOMETHING()",
    );
  });
});
