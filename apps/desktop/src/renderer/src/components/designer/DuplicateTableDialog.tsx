import { useEffect, useState } from 'react';

import {
  closeDuplicateTable,
  copyNameIssue,
  duplicateTableScript,
  scriptText,
  submitDuplicateTable,
  useDuplicateRequest,
  type DuplicateRequest,
} from '../../state/table-actions';
import { Button, Input, Modal } from '../ui';

/**
 * Duplicate Table (structure and data, or structure only) from the explorer's menu: the copy's
 * name, ready to type over, and the script that makes it, which follows the name as it is typed.
 */
export function DuplicateTableHost() {
  const request = useDuplicateRequest((state) => state.request);
  if (!request) return null;
  return (
    <DuplicateTableDialog
      // A new request (another table) starts the name over.
      key={`${request.profile.id}\u0000${request.table.schema}\u0000${request.table.name}\u0000${request.mode}`}
      request={request}
    />
  );
}

function DuplicateTableDialog(props: { readonly request: DuplicateRequest }) {
  const { request } = props;
  const { dialect, table } = request;
  const [name, setName] = useState(request.initial);
  const [edited, setEdited] = useState(false);
  // The first free name is known once the schema is read: take it unless the user typed.
  useEffect(() => {
    if (!edited) setName(request.initial);
  }, [edited, request.initial]);
  const issue = request.loading
    ? undefined
    : copyNameIssue(name, dialect, [...request.taken, table.name]);
  const script = scriptText(
    duplicateTableScript(
      table,
      name.trim() === '' ? '…' : name,
      dialect,
      request.mode,
      request.live,
    ),
    dialect,
  );
  const busy = request.loading || request.running;
  const submit = (): void => {
    if (!busy && issue === undefined) void submitDuplicateTable(name);
  };
  const withData = request.mode === 'structure-and-data';
  return (
    <Modal
      open
      onOpenChange={(open) => !open && !request.running && closeDuplicateTable()}
      title={`Duplicate table ${table.name}`}
      description={
        withData
          ? 'A new table with the same columns, keys, indexes and checks, and a copy of every row.'
          : 'A new, empty table with the same columns, keys, indexes and checks.'
      }
      width="w-[640px]"
      footer={
        <>
          <Button variant="ghost" onClick={closeDuplicateTable} disabled={request.running}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={submit}
            disabled={busy || issue !== undefined}
            data-testid="duplicate-table-run"
          >
            {request.running ? 'Duplicating…' : 'Duplicate'}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {request.error && (
          <p
            role="alert"
            data-testid="duplicate-table-error"
            className="rounded border border-danger/50 bg-danger/10 p-2 text-xs text-danger"
          >
            {request.error}
          </p>
        )}
        <label className="flex flex-col gap-1 text-xs font-medium text-muted">
          Name of the copy
          <Input
            autoFocus
            value={name}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => {
              setEdited(true);
              setName(event.target.value);
            }}
            aria-invalid={issue !== undefined && name !== '' ? true : undefined}
            spellCheck={false}
            data-testid="duplicate-table-name"
          />
          {issue !== undefined && name !== '' && (
            <span className="font-normal text-danger">{issue}</span>
          )}
        </label>
        <section aria-label="Script">
          <h3 className="mb-1 text-xs font-semibold">
            Script{dialect === 'postgres' ? ' (one transaction)' : ''}
          </h3>
          <pre
            data-testid="duplicate-table-script"
            className="max-h-[40vh] overflow-auto rounded border border-border bg-panel-2 p-2 font-mono text-xs whitespace-pre-wrap select-text"
          >
            {script}
          </pre>
          <p className="mt-1.5 text-[11px] text-muted">Foreign keys and triggers are not copied.</p>
        </section>
      </form>
    </Modal>
  );
}
