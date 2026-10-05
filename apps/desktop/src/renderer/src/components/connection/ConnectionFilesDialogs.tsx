import type { ConnectionsFilePreview } from '@querybara/ipc';
import { useMemo, useState, type FormEvent } from 'react';

import { errorMessage } from '../../lib/errors';
import { mainApi } from '../../lib/main-client';
import { showStatus } from '../../state/commands';
import {
  EXPORT_EXTENSION,
  IMPORT_FILTERS,
  closeConnectionFilesDialog,
  endpointLabel,
  exportSummary,
  folderPathsById,
  importKeys,
  importSummary,
  useConnectionFiles,
} from '../../state/connection-files';
import { keys, queryClient, useFolders, useProfiles } from '../../state/data';
import { EngineIcon } from '../EngineIcon';
import { Button, Field, Input, Modal } from '../ui';

/** Whichever connection file dialog is open: Import connections or Export connections. */
export function ConnectionFilesDialogs() {
  const dialog = useConnectionFiles((state) => state.dialog);
  if (!dialog) return null;
  return dialog.kind === 'import' ? (
    <ImportConnectionsDialog onClose={closeConnectionFilesDialog} />
  ) : (
    <ExportConnectionsDialog
      {...(dialog.profileIds ? { profileIds: dialog.profileIds } : {})}
      onClose={closeConnectionFilesDialog}
    />
  );
}

const FORMAT_LABELS: Readonly<Record<ConnectionsFilePreview['format'], string>> = {
  querybara: 'Querybara export',
  navicat: 'Navicat connections',
};

/**
 * Import connections: a Querybara export (asks for its passphrase) or a Navicat `.ncx` file.
 * The file's connections are listed with what would happen to each, and only the ticked ones
 * are imported. Connections that already exist are left alone unless Replace is ticked.
 */
function ImportConnectionsDialog(props: { readonly onClose: () => void }) {
  const [path, setPath] = useState<string>();
  const [passphrase, setPassphrase] = useState('');
  const [preview, setPreview] = useState<ConnectionsFilePreview>();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [replace, setReplace] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const inspect = async (file: string, secret?: string): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await mainApi().profiles.inspectFile({
        path: file,
        ...(secret ? { passphrase: secret } : {}),
      });
      setPreview(result);
      setSelected(new Set(result.entries.map((entry) => entry.key)));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const choose = async (): Promise<void> => {
    const picked = (
      await mainApi().dialogs.openFile({ title: 'Import connections', filters: IMPORT_FILTERS })
    ).path;
    if (picked === null) return;
    setPath(picked);
    setPassphrase('');
    setPreview(undefined);
    setReplace(false);
    await inspect(picked);
  };

  const unlock = (event: FormEvent): void => {
    event.preventDefault();
    if (path && passphrase !== '') void inspect(path, passphrase);
  };

  const chosen = preview && !preview.locked ? importKeys(preview, selected, replace) : [];

  const run = async (): Promise<void> => {
    if (!path || chosen.length === 0) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await mainApi().profiles.importFile({
        path,
        ...(passphrase ? { passphrase } : {}),
        keys: chosen,
        replace,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.profiles }),
        queryClient.invalidateQueries({ queryKey: keys.folders }),
      ]);
      showStatus('info', importSummary(result), 8000);
      props.onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (key: string): void => {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelected(next);
  };

  const entries = preview?.entries ?? [];
  const existing = entries.filter((entry) => entry.existing !== undefined).length;
  const allTicked = entries.length > 0 && entries.every((entry) => selected.has(entry.key));

  return (
    <Modal
      open
      onOpenChange={(open) => !open && props.onClose()}
      title="Import connections"
      description="From a Querybara export file or a Navicat connections file (.ncx)."
      width="w-[680px]"
      footer={
        <>
          <span
            className="mr-auto self-center text-xs text-danger"
            role={error ? 'alert' : undefined}
          >
            {error ?? ''}
          </span>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void run()}
            disabled={busy || chosen.length === 0}
          >
            {chosen.length > 0 ? `Import ${chosen.length}` : 'Import'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col items-stretch gap-3 text-xs" data-testid="import-connections">
        <div className="flex items-center gap-2">
          <Button onClick={() => void choose()} disabled={busy}>
            Choose file…
          </Button>
          {path && <span className="min-w-0 truncate font-mono">{path}</span>}
        </div>
        {preview?.locked && (
          <form className="flex items-end gap-2" onSubmit={unlock}>
            <Field
              label="Passphrase"
              htmlFor="import-passphrase"
              className="flex-1"
              hint="The passphrase the file was exported with."
            >
              <Input
                id="import-passphrase"
                type="password"
                autoFocus
                autoComplete="off"
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
              />
            </Field>
            <Button type="submit" className="mb-5" disabled={busy || passphrase === ''}>
              Open
            </Button>
          </form>
        )}
        {preview && !preview.locked && (
          <>
            <p className="text-muted">
              {FORMAT_LABELS[preview.format]}
              {preview.exportedAt
                ? `, exported ${new Date(preview.exportedAt).toLocaleString()}`
                : ''}
              {' · '}
              {entries.length === 1 ? '1 connection' : `${entries.length} connections`}
            </p>
            {entries.length > 0 && (
              <>
                <label className="flex items-center gap-1.5 font-medium">
                  <input
                    type="checkbox"
                    checked={allTicked}
                    onChange={(event) =>
                      setSelected(
                        new Set(event.target.checked ? entries.map((entry) => entry.key) : []),
                      )
                    }
                  />
                  All connections
                </label>
                <ul
                  className="max-h-72 overflow-auto rounded border border-border p-1"
                  aria-label="Connections in the file"
                >
                  {entries.map((entry) => {
                    const blocked = entry.existing !== undefined && !replace;
                    return (
                      <li key={entry.key}>
                        <label
                          className={`flex items-start gap-1.5 rounded px-1.5 py-1 hover:bg-hover ${blocked ? 'opacity-60' : ''}`}
                        >
                          <input
                            type="checkbox"
                            className="mt-0.5"
                            checked={selected.has(entry.key) && !blocked}
                            disabled={blocked}
                            onChange={() => toggle(entry.key)}
                          />
                          <EngineIcon engine={entry.profile.engine} className="mt-px shrink-0" />
                          <span className="flex min-w-0 flex-1 flex-col">
                            <span className="flex items-center gap-2">
                              <span className="truncate font-medium">{entry.profile.name}</span>
                              {entry.existing && (
                                <span className="shrink-0 rounded-sm bg-hover px-1 text-[10px] text-muted">
                                  {replace ? 'Replaces' : 'Exists'} “{entry.existing.name}”
                                </span>
                              )}
                            </span>
                            <span className="truncate text-muted">
                              {endpointLabel(entry.profile)}
                              {entry.folder ? ` · ${entry.folder}` : ''}
                              {entry.savedLogins > 0
                                ? ` · ${entry.savedLogins} saved ${entry.savedLogins === 1 ? 'password' : 'passwords'}`
                                : ''}
                            </span>
                            {entry.notes.map((note) => (
                              <span key={note} className="text-warning">
                                {note}
                              </span>
                            ))}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
            {existing > 0 && (
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={replace}
                  onChange={(event) => setReplace(event.target.checked)}
                />
                Replace the {existing === 1 ? 'connection' : `${existing} connections`} that already
                exist
              </label>
            )}
            {preview.skipped.length > 0 && (
              <div className="flex flex-col gap-0.5">
                <p className="font-medium text-muted">Not imported</p>
                {preview.skipped.map((entry, index) => (
                  <p key={`${index}:${entry.name}`} className="text-muted">
                    {entry.name}: {entry.reason}
                  </p>
                ))}
              </div>
            )}
            {preview.format === 'navicat' && (
              <p className="text-muted">
                Passwords saved in the file are saved in the OS keychain. Treat the file as a
                secret: anyone who has it can read them.
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

/**
 * Export connections to a passphrase-encrypted file (AES-256-GCM, scrypt), which the app and
 * `querybara profiles import` read. Saved passwords go in only when asked.
 */
function ExportConnectionsDialog(props: {
  readonly profileIds?: readonly string[];
  readonly onClose: () => void;
}) {
  const profiles = useProfiles().data ?? [];
  const folders = useFolders().data;
  const folderPaths = useMemo(() => folderPathsById(folders ?? []), [folders]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(props.profileIds ?? profiles.map((p) => p.id)),
  );
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  // Profiles load after the dialog opens when nothing had listed them yet.
  const [seeded, setSeeded] = useState(profiles.length > 0 || props.profileIds !== undefined);
  if (!seeded && profiles.length > 0) {
    setSeeded(true);
    setSelected(new Set(profiles.map((p) => p.id)));
  }

  const chosen = profiles.filter((p) => selected.has(p.id));
  const mismatch = repeat !== '' && repeat !== passphrase;
  const ready = chosen.length > 0 && passphrase !== '' && repeat === passphrase;

  const run = async (): Promise<void> => {
    if (!ready) return;
    setError(undefined);
    const path = (
      await mainApi().dialogs.saveFile({
        title: 'Export connections',
        defaultName: `querybara-connections.${EXPORT_EXTENSION}`,
        filters: [{ name: 'Querybara connections', extensions: [EXPORT_EXTENSION] }],
      })
    ).path;
    if (path === null) return;
    setBusy(true);
    try {
      const result = await mainApi().profiles.exportFile({
        path,
        profileIds: chosen.map((p) => p.id),
        passphrase,
        includeSecrets,
      });
      showStatus('info', exportSummary(result, includeSecrets), 8000);
      props.onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string): void => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  const all = profiles.length > 0 && chosen.length === profiles.length;

  return (
    <Modal
      open
      onOpenChange={(open) => !open && props.onClose()}
      title="Export connections"
      description="To a file encrypted with a passphrase, for Querybara on another computer or the querybara CLI."
      width="w-[600px]"
      footer={
        <>
          <span
            className="mr-auto self-center text-xs text-danger"
            role={error ? 'alert' : undefined}
          >
            {error ?? ''}
          </span>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void run()} disabled={busy || !ready}>
            Export…
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-xs" data-testid="export-connections">
        <label className="flex items-center gap-1.5 font-medium">
          <input
            type="checkbox"
            checked={all}
            onChange={(event) =>
              setSelected(new Set(event.target.checked ? profiles.map((p) => p.id) : []))
            }
          />
          All connections ({profiles.length})
        </label>
        <ul
          className="max-h-60 overflow-auto rounded border border-border p-1"
          aria-label="Connections to export"
        >
          {profiles.map((profile) => {
            const folder = profile.presentation.folderId
              ? folderPaths.get(profile.presentation.folderId)
              : undefined;
            return (
              <li key={profile.id}>
                <label className="flex items-center gap-1.5 rounded px-1.5 py-0.5 hover:bg-hover">
                  <input
                    type="checkbox"
                    checked={selected.has(profile.id)}
                    onChange={() => toggle(profile.id)}
                  />
                  <EngineIcon engine={profile.engine} className="shrink-0" />
                  <span className="truncate">{profile.name}</span>
                  <span className="ml-auto truncate pl-2 text-muted">
                    {folder ? `${folder} · ` : ''}
                    {endpointLabel(profile)}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        <label className="flex items-start gap-1.5">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={includeSecrets}
            onChange={(event) => setIncludeSecrets(event.target.checked)}
          />
          <span>
            Include saved passwords
            <span className="block text-muted">
              Passwords, passphrases and tokens saved on this computer, encrypted in the file with
              the passphrase.
            </span>
          </span>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Passphrase" htmlFor="export-passphrase">
            <Input
              id="export-passphrase"
              type="password"
              autoComplete="new-password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
            />
          </Field>
          <Field
            label="Repeat the passphrase"
            htmlFor="export-passphrase-repeat"
            error={mismatch ? 'The passphrases do not match' : undefined}
          >
            <Input
              id="export-passphrase-repeat"
              type="password"
              autoComplete="new-password"
              aria-invalid={mismatch}
              value={repeat}
              onChange={(event) => setRepeat(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void run();
              }}
            />
          </Field>
        </div>
        <p className="text-muted">
          The file cannot be opened without the passphrase, and the passphrase cannot be recovered.
        </p>
      </div>
    </Modal>
  );
}
