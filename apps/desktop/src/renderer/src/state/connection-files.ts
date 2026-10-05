import type {
  ConnectionsExportResult,
  ConnectionsFilePreview,
  ConnectionsImportResult,
  Folder,
  StoredProfile,
} from '@querybara/ipc';
import { create } from 'zustand';

/**
 * Import and export of connections (spec §4): which dialog is open, and the wording both
 * dialogs share. Import reads a Querybara export or a Navicat `.ncx` file; export writes the
 * passphrase-encrypted file the CLI reads too. Main does the reading and writing, so secrets
 * stay there (main/profile-files.ts).
 */

export type ConnectionFilesDialog =
  | { readonly kind: 'import' }
  | { readonly kind: 'export'; readonly profileIds?: readonly string[] };

interface ConnectionFilesState {
  readonly dialog: ConnectionFilesDialog | undefined;
}

export const useConnectionFiles = create<ConnectionFilesState>()(() => ({ dialog: undefined }));

export function openImportConnections(): void {
  useConnectionFiles.setState({ dialog: { kind: 'import' } });
}

/** Opens the export dialog with `profileIds` ticked, or every connection. */
export function openExportConnections(profileIds?: readonly string[]): void {
  useConnectionFiles.setState({
    dialog: { kind: 'export', ...(profileIds ? { profileIds } : {}) },
  });
}

export function closeConnectionFilesDialog(): void {
  useConnectionFiles.setState({ dialog: undefined });
}

/** The extension Querybara gives connection exports; the import also takes any other name. */
export const EXPORT_EXTENSION = 'qbx';

export const IMPORT_FILTERS = [
  { name: 'Connection files', extensions: [EXPORT_EXTENSION, 'ncx'] },
  { name: 'All files', extensions: ['*'] },
];

/** Where a profile connects, in a few words: "db.example.com:5432", a socket, a URI. */
export function endpointLabel(profile: Pick<StoredProfile, 'endpoint'>): string {
  const endpoint = profile.endpoint;
  const hostPort = (h: { host: string; port: number }) =>
    `${h.host.includes(':') ? `[${h.host}]` : h.host}:${h.port}`;
  switch (endpoint.kind) {
    case 'host':
      return hostPort(endpoint);
    case 'socket':
      return endpoint.path;
    case 'uri':
      return endpoint.uri;
    case 'hosts':
      return endpoint.hosts.map(hostPort).join(', ');
    case 'srv':
      return `${endpoint.host} (SRV)`;
    case 'sentinel':
      return `${endpoint.masterName} via ${endpoint.sentinels.map(hostPort).join(', ')}`;
    case 'cluster':
      return endpoint.seeds.map(hostPort).join(', ');
    case 'urls':
      return endpoint.urls.join(', ');
    case 'cloudId':
      return 'Elastic Cloud';
  }
}

/** The entries an import takes: the chosen ones, less those that exist unless replacing. */
export function importKeys(
  preview: Pick<ConnectionsFilePreview, 'entries'>,
  selected: ReadonlySet<string>,
  replace: boolean,
): string[] {
  return preview.entries
    .filter((entry) => selected.has(entry.key) && (replace || entry.existing === undefined))
    .map((entry) => entry.key);
}

function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "Imported 3 connections (1 replaced), 2 passwords saved." and what was not. */
export function importSummary(result: ConnectionsImportResult): string {
  const parts = [
    `Imported ${count(result.added + result.replaced, 'connection')}${
      result.replaced > 0 ? ` (${result.replaced} replaced)` : ''
    }`,
  ];
  if (result.savedLogins > 0) parts.push(`${count(result.savedLogins, 'password')} saved`);
  let text = `${parts.join(', ')}.`;
  if (result.skipped > 0) text += ` ${count(result.skipped, 'connection')} already existed.`;
  if (result.unsavedLogins > 0) {
    text += ` ${count(result.unsavedLogins, 'password')} could not be saved without a keychain; you are asked when connecting.`;
  }
  return text;
}

/** "Exported 4 connections with 3 passwords." and the passwords left out. */
export function exportSummary(result: ConnectionsExportResult, includeSecrets: boolean): string {
  let text = `Exported ${count(result.profiles, 'connection')}${
    includeSecrets ? ` with ${count(result.logins, 'password')}` : ''
  }.`;
  if (result.unreadable > 0) {
    text += ` ${count(result.unreadable, 'saved password')} could not be read here and ${
      result.unreadable === 1 ? 'was' : 'were'
    } left out.`;
  }
  return text;
}

/** Each folder's path from the root ("Shop / Production"), by id. */
export function folderPathsById(folders: readonly Pick<Folder, 'id' | 'parentId' | 'name'>[]) {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const paths = new Map<string, string>();
  const pathOf = (id: string, seen: ReadonlySet<string>): string => {
    const known = paths.get(id);
    if (known !== undefined) return known;
    const folder = byId.get(id);
    if (!folder) return '';
    const parent =
      folder.parentId !== null && !seen.has(folder.parentId)
        ? pathOf(folder.parentId, new Set(seen).add(id))
        : '';
    const path = parent === '' ? folder.name : `${parent} / ${folder.name}`;
    paths.set(id, path);
    return path;
  };
  for (const folder of folders) pathOf(folder.id, new Set());
  return paths;
}
