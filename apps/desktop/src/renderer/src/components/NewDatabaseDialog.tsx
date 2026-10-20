import { isSqlEngine, type SqlDialect } from '@querybara/core';
import type { StoredProfile } from '@querybara/ipc';
import { useEffect, useState } from 'react';

import { errorMessage } from '../lib/errors';
import {
  EMPTY_DATABASE_FORM,
  NO_CHOICES,
  POSTGRES_ENCODINGS,
  buildCreateDatabase,
  changeDatabaseForm,
  closeNewDatabase,
  createDatabase,
  loadDatabaseChoices,
  useNewDatabaseRequest,
  type DatabaseChoices,
  type NewDatabaseForm,
} from '../state/new-database';
import { SessionLane } from '../state/session-lane';
import { CommandPreview } from './mongo/parts';
import { Button, Field, Input, Modal, Select } from './ui';

/**
 * The "New database…" dialog of a SQL connection: the name, the character set and collation
 * (MySQL, MariaDB) or the owner, encoding and template (PostgreSQL), and the statement it runs.
 */
export function NewDatabaseHost() {
  const profile = useNewDatabaseRequest((state) => state.profile);
  if (!profile || !isSqlEngine(profile.engine)) return null;
  return <NewDatabaseDialog key={profile.id} profile={profile} dialect={profile.engine} />;
}

function NewDatabaseDialog(props: {
  readonly profile: StoredProfile;
  readonly dialect: SqlDialect;
}) {
  const { profile, dialect } = props;
  const [lane, setLane] = useState<SessionLane>();
  const [choices, setChoices] = useState<DatabaseChoices>();
  const [form, setForm] = useState<NewDatabaseForm>(EMPTY_DATABASE_FORM);
  const [touched, setTouched] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>();

  // The dialog's own session: it reads the choices and runs the statement.
  useEffect(() => {
    let current = true;
    const own = new SessionLane(profile.id);
    setLane(own);
    loadDatabaseChoices(own, dialect).then(
      (loaded) => current && setChoices(loaded),
      (e: unknown) => {
        if (!current) return;
        setChoices(NO_CHOICES);
        setError(errorMessage(e));
      },
    );
    return () => {
      current = false;
      void own.close();
    };
  }, [profile.id, dialect]);

  const built = buildCreateDatabase(dialect, form, choices?.existing);
  const issues: Readonly<Record<string, string>> = built.ok ? {} : built.issues;
  const change = (patch: Partial<NewDatabaseForm>): void => {
    setForm((was) => changeDatabaseForm(was, patch));
    setError(undefined);
  };
  const close = (): void => {
    if (!running) closeNewDatabase();
  };
  const run = async (): Promise<void> => {
    setTouched(true);
    if (!built.ok || !lane) return;
    setRunning(true);
    setError(undefined);
    const outcome = await createDatabase(lane, profile, built.statement);
    setRunning(false);
    if (outcome.ok) closeNewDatabase();
    else if (!outcome.cancelled) setError(outcome.message);
  };
  const id = (name: string): string => `new-database-${name}`;
  const charsetDefault =
    choices?.charsets.find((c) => c.name === (form.charset || choices.serverCharset))
      ?.defaultCollation ?? '';

  return (
    <Modal
      open
      onOpenChange={(open) => !open && close()}
      title={`New database on ${profile.name}`}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={running}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void run()}
            disabled={!built.ok || running || choices === undefined}
            data-testid="new-database-create"
          >
            {running ? 'Creating…' : 'Create'}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        data-testid="new-database-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        {error && (
          <p
            role="alert"
            className="rounded border border-danger/50 bg-danger/10 p-2 text-xs text-danger"
          >
            {error}
          </p>
        )}
        <Field
          label="Name"
          htmlFor={id('name')}
          error={touched || form.name !== '' ? issues['name'] : undefined}
        >
          <Input
            id={id('name')}
            autoFocus
            spellCheck={false}
            value={form.name}
            onChange={(event) => change({ name: event.target.value })}
            className="font-mono"
            data-testid="new-database-name"
          />
        </Field>
        {dialect === 'postgres' ? (
          <div className="grid grid-cols-3 gap-2">
            <Field label="Owner" htmlFor={id('owner')}>
              <Select
                id={id('owner')}
                value={form.owner}
                onChange={(event) => change({ owner: event.target.value })}
                data-testid="new-database-owner"
              >
                <option value="">Default (you)</option>
                {choices?.roles.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Encoding" htmlFor={id('encoding')}>
              <Select
                id={id('encoding')}
                value={form.encoding}
                onChange={(event) => change({ encoding: event.target.value })}
                data-testid="new-database-encoding"
              >
                <option value="">Template&rsquo;s</option>
                {POSTGRES_ENCODINGS.map((encoding) => (
                  <option key={encoding} value={encoding}>
                    {encoding}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Template" htmlFor={id('template')}>
              <Select
                id={id('template')}
                value={form.template}
                onChange={(event) => change({ template: event.target.value })}
                data-testid="new-database-template"
              >
                <option value="">Default (template1)</option>
                {choices?.templates
                  .filter((template) => template !== 'template1')
                  .map((template) => (
                    <option key={template} value={template}>
                      {template}
                    </option>
                  ))}
              </Select>
            </Field>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <Field label="Character set" htmlFor={id('charset')} error={issues['charset']}>
              <Select
                id={id('charset')}
                value={form.charset}
                onChange={(event) => change({ charset: event.target.value })}
                data-testid="new-database-charset"
              >
                <option value="">
                  Server default{choices?.serverCharset ? ` (${choices.serverCharset})` : ''}
                </option>
                {choices?.charsets.map((charset) => (
                  <option key={charset.name} value={charset.name}>
                    {charset.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Collation" htmlFor={id('collation')} error={issues['collation']}>
              <Select
                id={id('collation')}
                value={form.collation}
                onChange={(event) => change({ collation: event.target.value })}
                data-testid="new-database-collation"
              >
                <option value="">Default{charsetDefault ? ` (${charsetDefault})` : ''}</option>
                {choices?.collations
                  .filter((c) => c.charset === (form.charset || choices.serverCharset))
                  .map((collation) => (
                    <option key={collation.name} value={collation.name}>
                      {collation.name}
                    </option>
                  ))}
              </Select>
            </Field>
          </div>
        )}
        <CommandPreview
          command={built.ok ? built.statement : undefined}
          testId="new-database-statement"
        />
        {/* Enter in the name field submits. */}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
