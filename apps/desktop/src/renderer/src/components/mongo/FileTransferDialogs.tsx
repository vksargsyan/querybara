import { MONGO_FILE_FORMATS, MONGO_IMPORT_MODES, type MongoFileFormat } from '@querybara/ipc';
import { useEffect, useState, type ReactNode } from 'react';

import { errorMessage } from '../../lib/errors';
import { mainApi } from '../../lib/main-client';
import { confirm } from '../../state/dialogs';
import { startJob } from '../../state/jobs';
import {
  IMPORT_FILTERS,
  MONGO_FORMAT_HINTS,
  MONGO_FORMAT_LABELS,
  MONGO_IMPORT_MODE_HINTS,
  MONGO_IMPORT_MODE_LABELS,
  buildExportJob,
  buildImportJob,
  closeMongoFileDialog,
  databaseCollections,
  exportFileName,
  exportFilters,
  exportIssue,
  exportSettings,
  importIssue,
  importQuestion,
  importSettings,
  refreshAfter,
  scanFields,
  useMongoFileDialog,
  withFile,
  type MongoExportSettings,
  type MongoExportTarget,
  type MongoImportSettings,
  type MongoImportTarget,
} from '../../state/mongo/file-transfer';
import { Button, Input, Modal, Select, cx } from '../ui';

/**
 * Studio 3T's Export and Import for MongoDB (ADR 0037): the dialogs that build a `mongo-export`
 * or `mongo-import` job. The job list shows it running; the side bar lists the collection an
 * import made.
 */

export function MongoFileDialogs() {
  const dialog = useMongoFileDialog((s) => s.dialog);
  if (!dialog) return null;
  return dialog.kind === 'export' ? (
    <MongoExportDialog target={dialog.target} onClose={closeMongoFileDialog} />
  ) : (
    <MongoImportDialog target={dialog.target} onClose={closeMongoFileDialog} />
  );
}

function Section(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-xs font-semibold text-muted">{props.title}</legend>
      {props.children}
    </fieldset>
  );
}

function Radio<T extends string>(props: {
  readonly name: string;
  readonly value: T;
  readonly checked: boolean;
  readonly onChange: (value: T) => void;
  readonly label: string;
  readonly hint?: string;
}) {
  return (
    <label className="flex items-start gap-2 text-xs">
      <input
        type="radio"
        name={props.name}
        value={props.value}
        checked={props.checked}
        onChange={() => props.onChange(props.value)}
        className="mt-0.5"
      />
      <span>
        {props.label}
        {props.hint !== undefined && <span className="block text-muted">{props.hint}</span>}
      </span>
    </label>
  );
}

function Check(props: {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly label: string;
}) {
  return (
    <label className="flex items-center gap-2 text-xs">
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(event) => props.onChange(event.target.checked)}
      />
      {props.label}
    </label>
  );
}

const DELIMITERS: readonly { readonly value: string; readonly label: string }[] = [
  { value: ',', label: 'Comma (,)' },
  { value: ';', label: 'Semicolon (;)' },
  { value: '\t', label: 'Tab' },
  { value: '|', label: 'Pipe (|)' },
];

function DelimiterSelect(props: {
  readonly id: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs">
      Delimiter
      <Select
        id={props.id}
        className="w-36"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
      >
        {DELIMITERS.map((option) => (
          <option key={option.label} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    </label>
  );
}

function Footer(props: {
  readonly error: string | undefined;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly title: string | undefined;
  readonly action: string;
  readonly onAction: () => void;
  readonly onClose: () => void;
}) {
  return (
    <>
      <span
        className="mr-auto self-center text-xs text-danger"
        role={props.error ? 'alert' : undefined}
      >
        {props.error ?? ''}
      </span>
      <Button variant="ghost" onClick={props.onClose}>
        Cancel
      </Button>
      <Button
        variant="primary"
        disabled={props.disabled || props.busy}
        title={props.title}
        onClick={props.onAction}
      >
        {props.action}
      </Button>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Export

function MongoExportDialog(props: {
  readonly target: MongoExportTarget;
  readonly onClose: () => void;
}) {
  const { target } = props;
  const [settings, setSettings] = useState<MongoExportSettings>(() => exportSettings(target));
  const [available, setAvailable] = useState<readonly string[]>(target.collections);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const set = (patch: Partial<MongoExportSettings>): void =>
    setSettings((current) => ({ ...current, ...patch }));
  useEffect(() => {
    if (target.query) return;
    let live = true;
    void databaseCollections(target.profileId, target.db)
      .then((names) => {
        if (live) setAvailable([...new Set([...target.collections, ...names])]);
      })
      .catch((e: unknown) => live && setError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [target]);
  const queried = settings.useQuery && target.query !== undefined;
  const collections = queried ? [target.query!.collection] : settings.collections;
  const single = collections.length === 1;
  const issue = exportIssue({ ...settings, collections });

  const choose = async (): Promise<void> => {
    setError(undefined);
    const path = single
      ? (
          await mainApi().dialogs.saveFile({
            title: `Export ${collections[0]!}`,
            defaultName: exportFileName(collections[0]!, settings.format, settings.gzip),
            filters: exportFilters(settings.format, settings.gzip),
          })
        ).path
      : (await mainApi().dialogs.openDirectory({ title: 'Choose a folder for the files' })).path;
    if (path !== null) set({ path });
  };
  const scan = async (): Promise<void> => {
    if (!single) return;
    setScanning(true);
    setError(undefined);
    try {
      set({ fields: await scanFields(target.profileId, target.db, collections[0]!) });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setScanning(false);
    }
  };
  const run = async (): Promise<void> => {
    if (issue !== undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      const jobId = await startJob(buildExportJob(target, { ...settings, collections }));
      if (jobId) props.onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const toggle = (name: string, on: boolean): void =>
    set({
      collections: on
        ? available.filter((c) => c === name || settings.collections.includes(c))
        : settings.collections.filter((c) => c !== name),
      path: undefined,
    });

  return (
    <Modal
      open
      onOpenChange={(open) => !open && props.onClose()}
      title="Export"
      description={`${target.profileName} · ${target.db}`}
      width="w-[640px]"
      footer={
        <Footer
          error={error}
          busy={busy}
          disabled={issue !== undefined}
          title={issue}
          action="Export"
          onAction={() => void run()}
          onClose={props.onClose}
        />
      }
    >
      <div className="flex flex-col gap-4" data-testid="mongo-export-dialog">
        <Section title="Documents">
          {target.query ? (
            <>
              <Radio
                name="mongo-export-source"
                value="query"
                checked={settings.useQuery}
                onChange={() => set({ useQuery: true })}
                label="What the query finds"
                hint={target.query.text}
              />
              <Radio
                name="mongo-export-source"
                value="all"
                checked={!settings.useQuery}
                onChange={() => set({ useQuery: false })}
                label={`Every document of ${target.query.collection}`}
              />
            </>
          ) : (
            <div
              className="flex max-h-40 flex-col gap-1 overflow-auto rounded-sm border border-border p-2"
              role="group"
              aria-label="Collections"
            >
              <div className="mb-1 flex gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => set({ collections: [...available], path: undefined })}
                >
                  Select all
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => set({ collections: [], path: undefined })}
                >
                  Select none
                </Button>
              </div>
              {available.map((name) => (
                <Check
                  key={name}
                  label={name}
                  checked={settings.collections.includes(name)}
                  onChange={(on) => toggle(name, on)}
                />
              ))}
            </div>
          )}
        </Section>
        <Section title="Format">
          <div className="grid grid-cols-2 gap-2">
            {MONGO_FILE_FORMATS.map((format) => (
              <Radio
                key={format}
                name="mongo-export-format"
                value={format}
                checked={settings.format === format}
                onChange={(next: MongoFileFormat) => set({ format: next, path: undefined })}
                label={MONGO_FORMAT_LABELS[format]}
                hint={MONGO_FORMAT_HINTS[format]}
              />
            ))}
          </div>
        </Section>
        {(settings.format === 'json' || settings.format === 'jsonl') && (
          <Section title="Extended JSON">
            <Radio
              name="mongo-export-ejson"
              value="relaxed"
              checked={settings.ejson === 'relaxed'}
              onChange={() => set({ ejson: 'relaxed' })}
              label="Relaxed"
              hint="Numbers and dates as plain JSON where nothing is lost"
            />
            <Radio
              name="mongo-export-ejson"
              value="canonical"
              checked={settings.ejson === 'canonical'}
              onChange={() => set({ ejson: 'canonical' })}
              label="Canonical"
              hint="Every type spelled out: Int32, Int64 and Double stay apart"
            />
            {settings.format === 'json' && (
              <Check
                label="Indent each document"
                checked={settings.pretty}
                onChange={(pretty) => set({ pretty })}
              />
            )}
          </Section>
        )}
        {settings.format === 'csv' && (
          <Section title="CSV">
            <div className="flex items-center gap-4">
              <DelimiterSelect
                id="mongo-export-delimiter"
                value={settings.delimiter}
                onChange={(delimiter) => set({ delimiter })}
              />
              <Check
                label="Field names in the first row"
                checked={settings.header}
                onChange={(header) => set({ header })}
              />
            </div>
            <label className="flex flex-col gap-1 text-xs" htmlFor="mongo-export-fields">
              <span className="flex items-center gap-2">
                Fields, one per line
                <span className="text-muted">(empty: those of the first 1,000 documents)</span>
                {single && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    disabled={scanning}
                    onClick={() => void scan()}
                  >
                    {scanning ? 'Scanning…' : 'Scan fields'}
                  </Button>
                )}
              </span>
              <textarea
                id="mongo-export-fields"
                rows={4}
                value={settings.fields.join('\n')}
                onChange={(event) =>
                  set({
                    fields: event.target.value
                      .split('\n')
                      .map((field) => field.trim())
                      .filter((field) => field !== ''),
                  })
                }
                className="rounded-sm border border-border bg-deep px-1.5 py-1 font-mono text-xs text-fg focus:border-focus focus:outline-none"
                placeholder={'_id\ncustomer.name\ntotal'}
              />
            </label>
          </Section>
        )}
        <Section title="Destination">
          <Check
            label="Compress with gzip"
            checked={settings.gzip}
            onChange={(gzip) => set({ gzip, path: undefined })}
          />
          <div className="flex items-center gap-2 text-xs">
            <Button size="sm" onClick={() => void choose()} disabled={collections.length === 0}>
              {single ? 'Choose file…' : 'Choose folder…'}
            </Button>
            <span
              className={cx('min-w-0 truncate', settings.path === undefined && 'text-muted')}
              data-testid="mongo-export-path"
              title={settings.path}
            >
              {settings.path ??
                (single ? 'No file chosen' : `A file per collection, ${collections.length} in all`)}
            </span>
          </div>
        </Section>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------------------
// Import

function MongoImportDialog(props: {
  readonly target: MongoImportTarget;
  readonly onClose: () => void;
}) {
  const { target } = props;
  const [settings, setSettings] = useState<MongoImportSettings>(() => importSettings(target));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<MongoImportSettings>): void =>
    setSettings((current) => ({ ...current, ...patch }));
  const issue = importIssue(target, settings);

  const choose = async (): Promise<void> => {
    setError(undefined);
    const picked = (
      await mainApi().dialogs.openFile({ title: 'Import a file', filters: IMPORT_FILTERS })
    ).path;
    if (picked !== null) setSettings((current) => withFile(target, current, picked));
  };
  const run = async (): Promise<void> => {
    if (issue !== undefined) return;
    const question = importQuestion(target, settings);
    if (question) {
      const ok = await confirm({
        title: question.title,
        message: question.message,
        confirmLabel: settings.mode === 'replace' ? 'Replace and import' : 'Import',
        danger: question.danger,
      });
      if (!ok) return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const jobId = await startJob(buildImportJob(target, settings, question !== undefined));
      if (jobId) {
        refreshAfter(jobId, target.profileId, target.db);
        props.onClose();
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onOpenChange={(open) => !open && props.onClose()}
      title="Import"
      description={`${target.profileName} · ${target.db}`}
      width="w-[640px]"
      footer={
        <Footer
          error={error}
          busy={busy}
          disabled={issue !== undefined}
          title={issue}
          action="Import"
          onAction={() => void run()}
          onClose={props.onClose}
        />
      }
    >
      <div className="flex flex-col gap-4" data-testid="mongo-import-dialog">
        <Section title="File">
          <div className="flex items-center gap-2 text-xs">
            <Button size="sm" onClick={() => void choose()}>
              Choose file…
            </Button>
            <span
              className={cx('min-w-0 truncate', settings.path === undefined && 'text-muted')}
              data-testid="mongo-import-path"
              title={settings.path}
            >
              {settings.path ?? 'JSON, JSON Lines, CSV or BSON, gzipped or not'}
            </span>
          </div>
          <label className="flex items-center gap-2 text-xs">
            Format
            <Select
              className="w-40"
              aria-label="Format"
              value={settings.format}
              onChange={(event) => set({ format: event.target.value as MongoFileFormat })}
            >
              {MONGO_FILE_FORMATS.map((format) => (
                <option key={format} value={format}>
                  {MONGO_FORMAT_LABELS[format]}
                </option>
              ))}
            </Select>
            <span className="text-muted">{MONGO_FORMAT_HINTS[settings.format]}</span>
          </label>
        </Section>
        {settings.format === 'csv' && (
          <Section title="CSV">
            <div className="flex items-center gap-4">
              <DelimiterSelect
                id="mongo-import-delimiter"
                value={settings.delimiter}
                onChange={(delimiter) => set({ delimiter })}
              />
              <Check
                label="Field names in the first row"
                checked={settings.header}
                onChange={(header) => set({ header })}
              />
            </div>
            <Radio
              name="mongo-import-types"
              value="infer"
              checked={settings.types === 'infer'}
              onChange={() => set({ types: 'infer' })}
              label="Read numbers, booleans, dates and JSON as their types"
              hint="Dotted field names (address.city) make sub-documents"
            />
            <Radio
              name="mongo-import-types"
              value="string"
              checked={settings.types === 'string'}
              onChange={() => set({ types: 'string' })}
              label="Keep every value as text"
            />
            <label className="flex items-center gap-2 text-xs">
              Empty fields
              <Select
                className="w-48"
                aria-label="Empty fields"
                value={settings.empty}
                onChange={(event) =>
                  set({ empty: event.target.value as MongoImportSettings['empty'] })
                }
              >
                <option value="omit">Leave the field out</option>
                <option value="null">Null</option>
                <option value="string">An empty string</option>
              </Select>
            </label>
          </Section>
        )}
        <Section title="Into">
          <label className="flex items-center gap-2 text-xs" htmlFor="mongo-import-collection">
            Collection
            <Input
              id="mongo-import-collection"
              className="w-64"
              value={settings.collection}
              readOnly={target.collection !== undefined}
              onChange={(event) => set({ collection: event.target.value })}
              placeholder="Named after the file"
            />
          </label>
          {MONGO_IMPORT_MODES.map((mode) => (
            <Radio
              key={mode}
              name="mongo-import-mode"
              value={mode}
              checked={settings.mode === mode}
              onChange={() => set({ mode })}
              label={MONGO_IMPORT_MODE_LABELS[mode]}
              hint={MONGO_IMPORT_MODE_HINTS[mode]}
            />
          ))}
        </Section>
        <Section title="When a document is refused">
          <Radio
            name="mongo-import-errors"
            value="stop"
            checked={settings.onError === 'stop'}
            onChange={() => set({ onError: 'stop' })}
            label="Stop there"
            hint="The documents before it stay imported"
          />
          <Radio
            name="mongo-import-errors"
            value="skip"
            checked={settings.onError === 'skip'}
            onChange={() => set({ onError: 'skip' })}
            label="Skip it and go on"
            hint="The job lists each one skipped"
          />
        </Section>
      </div>
    </Modal>
  );
}
