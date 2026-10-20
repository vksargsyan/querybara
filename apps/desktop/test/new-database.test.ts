import { describe, expect, it } from 'vitest';

import type { HostClient } from '../src/renderer/src/lib/main-client';
import {
  EMPTY_DATABASE_FORM,
  buildCreateDatabase,
  changeDatabaseForm,
  databaseNameIssue,
  loadDatabaseChoices,
  type NewDatabaseForm,
} from '../src/renderer/src/state/new-database';
import type { SessionLane } from '../src/renderer/src/state/session-lane';

/** The "New database…" dialog of a SQL connection: the form to its CREATE DATABASE statement. */

function form(patch: Partial<NewDatabaseForm>): NewDatabaseForm {
  return { ...EMPTY_DATABASE_FORM, ...patch };
}

describe('new database statement', () => {
  it('names the database alone when no option is set', () => {
    expect(buildCreateDatabase('mysql', form({ name: 'shop' }))).toEqual({
      ok: true,
      statement: 'CREATE DATABASE `shop`',
    });
    expect(buildCreateDatabase('postgres', form({ name: 'Shop "2"' }))).toEqual({
      ok: true,
      statement: 'CREATE DATABASE "Shop ""2"""',
    });
  });

  it('adds the character set and collation on MySQL and MariaDB', () => {
    const built = buildCreateDatabase(
      'mariadb',
      form({ name: 'shop', charset: 'utf8mb4', collation: 'utf8mb4_bin' }),
    );
    expect(built).toEqual({
      ok: true,
      statement: 'CREATE DATABASE `shop` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin',
    });
    expect(buildCreateDatabase('mysql', form({ name: 'shop', charset: 'utf8; DROP' }))).toEqual({
      ok: false,
      issues: { charset: 'Not a character set name' },
    });
  });

  it('adds the owner, template and encoding on PostgreSQL', () => {
    const built = buildCreateDatabase(
      'postgres',
      form({ name: 'shop', owner: 'app', template: 'template0', encoding: 'LATIN1' }),
    );
    expect(built).toEqual({
      ok: true,
      statement: `CREATE DATABASE "shop" OWNER "app" TEMPLATE "template0" ENCODING 'LATIN1'`,
    });
  });

  it('refuses names the server would refuse or cut', () => {
    expect(databaseNameIssue('', 'mysql')).toBe('Name the database');
    expect(databaseNameIssue(' shop', 'postgres')).toMatch(/spaces/);
    expect(databaseNameIssue('a'.repeat(64), 'mysql')).toBeUndefined();
    expect(databaseNameIssue('a'.repeat(65), 'mysql')).toBe('At most 64 characters');
    // 32 two-byte characters: 64 bytes, past PostgreSQL's 63.
    expect(databaseNameIssue('é'.repeat(32), 'postgres')).toBe('At most 63 bytes');
    expect(databaseNameIssue('shop', 'postgres', ['postgres', 'shop'])).toMatch(/exists already/);
    expect(buildCreateDatabase('mysql', form({ name: '' }))).toEqual({
      ok: false,
      issues: { name: 'Name the database' },
    });
  });

  it('moves an encoding off template1 and a collation off a changed character set', () => {
    expect(changeDatabaseForm(form({}), { encoding: 'LATIN1' })).toMatchObject({
      encoding: 'LATIN1',
      template: 'template0',
    });
    expect(changeDatabaseForm(form({ template: 'base' }), { encoding: 'LATIN1' }).template).toBe(
      'base',
    );
    expect(
      changeDatabaseForm(form({ charset: 'utf8mb4', collation: 'utf8mb4_bin' }), {
        charset: 'latin1',
      }),
    ).toMatchObject({ charset: 'latin1', collation: '' });
    expect(
      changeDatabaseForm(form({ charset: 'utf8mb4' }), { collation: 'utf8mb4_bin' }).collation,
    ).toBe('utf8mb4_bin');
  });
});

/** A lane whose host answers each query from `answers`, by its text. */
function laneAnswering(answers: Readonly<Record<string, readonly (readonly string[])[]>>) {
  const asked: string[] = [];
  const host = {
    async *execute(input: { text: string }) {
      asked.push(input.text);
      const rows = Object.entries(answers).find(([sql]) => input.text.includes(sql))?.[1];
      if (!rows) throw new Error(`denied: ${input.text}`);
      const width = rows[0]?.length ?? 1;
      yield {
        type: 'rows',
        resultIndex: 0,
        rowCount: rows.length,
        data: Array.from({ length: width }, (_, c) => rows.map((row) => row[c])),
      };
    },
  } as unknown as HostClient;
  const lane = {
    run: <T>(task: (host: HostClient, sessionId: string) => Promise<T>) => task(host, 's1'),
  } as unknown as SessionLane;
  return { lane, asked };
}

describe('new database choices', () => {
  it('reads MySQL character sets, collations and the server default', async () => {
    const { lane } = laneAnswering({
      SCHEMATA: [['mysql'], ['shop']],
      CHARACTER_SETS: [
        ['latin1', 'latin1_swedish_ci'],
        ['utf8mb4', 'utf8mb4_0900_ai_ci'],
      ],
      COLLATIONS: [
        ['latin1_bin', 'latin1'],
        ['utf8mb4_bin', 'utf8mb4'],
      ],
      '@@character_set_server': [['utf8mb4']],
    });
    const choices = await loadDatabaseChoices(lane, 'mysql');
    expect(choices).toMatchObject({
      existing: ['mysql', 'shop'],
      charsets: [
        { name: 'latin1', defaultCollation: 'latin1_swedish_ci' },
        { name: 'utf8mb4', defaultCollation: 'utf8mb4_0900_ai_ci' },
      ],
      collations: [
        { name: 'latin1_bin', charset: 'latin1' },
        { name: 'utf8mb4_bin', charset: 'utf8mb4' },
      ],
      serverCharset: 'utf8mb4',
    });
  });

  it('reads PostgreSQL roles and templates, leaving out a list it may not read', async () => {
    const { lane } = laneAnswering({
      'pg_database ORDER BY': [['postgres'], ['template0'], ['template1']],
      datistemplate: [['template0'], ['template1']],
    });
    const choices = await loadDatabaseChoices(lane, 'postgres');
    expect(choices).toMatchObject({
      existing: ['postgres', 'template0', 'template1'],
      roles: [],
      templates: ['template0', 'template1'],
    });
  });
});
