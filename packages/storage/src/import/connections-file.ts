import {
  QuerybaraError,
  secretRefsOf,
  type ConnectionProfile,
  type EngineId,
} from '@querybara/core';

import type { Store } from '../store';
import type { StoredProfile } from '../repositories/profiles';
import { hasMagic, type ScryptCost } from '../secrets/envelope';
import { EXPORT_MAGIC, exportProfiles, importProfiles, type ExportedFolder } from './export';
import { isNavicatConnections, parseNavicatConnections, type SkippedConnection } from './navicat';

/**
 * A file of connections to import, whatever wrote it: a Querybara export (encrypted with a
 * passphrase) or a Navicat `.ncx` file. Both the CLI and the desktop read it here, preview it
 * against the store, and apply it with the same rules; they export through here too.
 */

export type ConnectionsFileFormat = 'querybara' | 'navicat';

export interface ConnectionsFileEntry {
  /** Names the entry for `applyConnectionsImport`; stable across reads of the same file. */
  readonly key: string;
  readonly profile: ConnectionProfile;
  /** What did not carry over. */
  readonly notes: readonly string[];
}

export interface ConnectionsFile {
  readonly format: ConnectionsFileFormat;
  /** When a Querybara export was written. */
  readonly exportedAt?: string;
  readonly entries: readonly ConnectionsFileEntry[];
  /** Parents first (Querybara exports only). */
  readonly folders: readonly ExportedFolder[];
  /** Secret values by SecretRef.id; JSON and inspect show `[redacted]`. */
  readonly secrets: Readonly<Record<string, string>>;
  /** Connections the file holds that cannot be imported. */
  readonly skipped: readonly SkippedConnection[];
}

/** The largest connections file read (a few thousand connections are well under a megabyte). */
export const CONNECTIONS_FILE_LIMIT = 16 * 1024 * 1024;

/** Which kind of connections file `data` is, or undefined for neither. */
export function connectionsFileFormat(data: Uint8Array): ConnectionsFileFormat | undefined {
  if (hasMagic(EXPORT_MAGIC, data)) return 'querybara';
  const text = decodeText(data);
  return text !== undefined && isNavicatConnections(text) ? 'navicat' : undefined;
}

/**
 * Reads a connections file. A Querybara export needs its passphrase (AUTH_FAILED when wrong);
 * a file of neither kind fails with VALIDATION_FAILED.
 */
export function readConnectionsFile(
  data: Uint8Array,
  options: { readonly passphrase?: string; readonly now?: () => Date } = {},
): ConnectionsFile {
  const format = connectionsFileFormat(data);
  if (format === 'querybara') {
    if (options.passphrase === undefined || options.passphrase === '') {
      throw new QuerybaraError({
        code: 'VALIDATION_FAILED',
        message: 'The export file is encrypted; its passphrase is needed',
      });
    }
    const imported = importProfiles(data, options.passphrase);
    return {
      format,
      exportedAt: imported.exportedAt,
      entries: imported.profiles.map((profile) => ({ key: profile.id, profile, notes: [] })),
      folders: imported.folders,
      secrets: imported.secrets,
      skipped: [],
    };
  }
  if (format === 'navicat') {
    const parsed = parseNavicatConnections(
      decodeText(data)!,
      options.now ? { now: options.now } : {},
    );
    return {
      format,
      entries: parsed.connections.map((c) => ({
        key: String(c.index),
        profile: c.profile,
        notes: c.notes,
      })),
      folders: [],
      secrets: parsed.secrets,
      skipped: parsed.skipped,
    };
  }
  throw new QuerybaraError({
    code: 'VALIDATION_FAILED',
    message: 'The file is not a Querybara connections export or a Navicat .ncx file',
  });
}

/**
 * The stored profile an entry would replace. A Querybara export keeps profile ids, so it
 * matches by id; a Navicat file has none, so it matches a profile of the same engine and name
 * (case-insensitive), which makes importing the same file twice replace rather than duplicate.
 */
export function existingProfileFor(
  file: Pick<ConnectionsFile, 'format'>,
  entry: ConnectionsFileEntry,
  profiles: readonly StoredProfile[],
): StoredProfile | undefined {
  if (file.format === 'querybara') return profiles.find((p) => p.id === entry.profile.id);
  return findByName(profiles, entry.profile.engine, entry.profile.name);
}

function findByName(
  profiles: readonly StoredProfile[],
  engine: EngineId,
  name: string,
): StoredProfile | undefined {
  const lower = name.toLowerCase();
  return profiles.find((p) => p.engine === engine && p.name.toLowerCase() === lower);
}

export interface ConnectionsImportOptions {
  /** Entries to import, by key; every entry when absent. */
  readonly keys?: readonly string[];
  /** Replace the profiles entries match; without it they are skipped. */
  readonly replace: boolean;
}

export interface ConnectionsImportResult {
  readonly added: number;
  readonly replaced: number;
  /** Matched an existing profile and `replace` was off. */
  readonly skipped: number;
  readonly savedSecrets: number;
  /** Secrets in the file that could not be saved here (no keychain or store passphrase). */
  readonly unsavedSecrets: number;
  /** The entries written and the profile each became, in file order. */
  readonly written: readonly { readonly key: string; readonly profileId: string }[];
}

/** Writes a file's folders, profiles and secrets into the store. */
export function applyConnectionsImport(
  store: Store,
  file: ConnectionsFile,
  options: ConnectionsImportOptions,
): ConnectionsImportResult {
  const wanted = options.keys === undefined ? undefined : new Set(options.keys);
  const entries = file.entries.filter((entry) => wanted === undefined || wanted.has(entry.key));

  for (const folder of file.folders) {
    if (store.folders.get(folder.id)) continue;
    const parentId =
      folder.parentId !== null && store.folders.get(folder.parentId) ? folder.parentId : null;
    store.folders.create({
      id: folder.id,
      name: folder.name,
      parentId,
      sortOrder: folder.sortOrder,
    });
  }

  let added = 0;
  let replaced = 0;
  let skipped = 0;
  let savedSecrets = 0;
  let unsavedSecrets = 0;
  const written: { key: string; profileId: string }[] = [];
  const canSave = store.secrets.canSave();
  // Matched against the profiles as they were, each at most once: two connections of one name
  // in a Navicat file do not both land on the same profile.
  const before = store.profiles.list();
  const claimed = new Set<string>();
  for (const entry of entries) {
    const match = existingProfileFor(file, entry, before);
    const existing = match && !claimed.has(match.id) ? match : undefined;
    if (existing) claimed.add(existing.id);
    if (existing && !options.replace) {
      skipped++;
      continue;
    }
    const folderId = entry.profile.presentation.folderId;
    const profile: ConnectionProfile = {
      ...entry.profile,
      ...(existing ? { id: existing.id } : {}),
      presentation: {
        ...entry.profile.presentation,
        folderId: folderId !== null && store.folders.get(folderId) ? folderId : null,
      },
    };
    const saved = store.profiles.save(profile);
    written.push({ key: entry.key, profileId: saved.id });
    if (existing) replaced++;
    else added++;
    for (const ref of secretRefsOf(profile)) {
      const value = Object.hasOwn(file.secrets, ref.id) ? file.secrets[ref.id] : undefined;
      if (value === undefined || ref.policy !== 'save') continue;
      if (!canSave) {
        unsavedSecrets++;
        continue;
      }
      store.secrets.set(ref, value);
      savedSecrets++;
    }
  }
  return { added, replaced, skipped, savedSecrets, unsavedSecrets, written };
}

/** UTF-8 (with or without a BOM) or UTF-16 with a BOM; undefined for anything else. */
function decodeText(data: Uint8Array): string | undefined {
  const encoding =
    data[0] === 0xff && data[1] === 0xfe
      ? 'utf-16le'
      : data[0] === 0xfe && data[1] === 0xff
        ? 'utf-16be'
        : 'utf-8';
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(data);
  } catch {
    return undefined;
  }
}

export interface ConnectionsExportOptions {
  readonly passphrase: string;
  /** Add the profiles' secrets that can be read here. */
  readonly includeSecrets: boolean;
  /** scrypt cost; lower it only in tests. */
  readonly cost?: ScryptCost;
  readonly now?: () => Date;
}

export interface ConnectionsExport {
  readonly data: Uint8Array;
  readonly secrets: number;
  /** Saved secrets that could not be read here, so the file does not hold them. */
  readonly unreadable: number;
}

/** Encrypts stored profiles, with the folders above them and optionally their secrets. */
export function exportConnections(
  store: Store,
  profiles: readonly StoredProfile[],
  options: ConnectionsExportOptions,
): ConnectionsExport {
  const allFolders = new Map(store.folders.list().map((f) => [f.id, f]));
  const folders = new Map<string, ExportedFolder>();
  for (const profile of profiles) {
    let id = profile.presentation.folderId;
    while (id !== null && !folders.has(id)) {
      const folder = allFolders.get(id);
      if (!folder) break;
      folders.set(id, {
        id,
        parentId: folder.parentId,
        name: folder.name,
        sortOrder: folder.sortOrder,
      });
      id = folder.parentId;
    }
  }
  let secrets: Record<string, string> | undefined;
  let unreadable = 0;
  if (options.includeSecrets) {
    secrets = {};
    for (const profile of profiles) {
      const resolved = store.secrets.resolve(profile);
      for (const [id, value] of Object.entries(resolved.secrets)) secrets[id] = value;
      unreadable += resolved.missing.filter((ref) => ref.policy === 'save').length;
    }
  }
  const data = exportProfiles(
    profiles.map(({ version: _version, ...profile }) => profile),
    {
      passphrase: options.passphrase,
      folders: [...folders.values()],
      ...(secrets ? { secrets } : {}),
      ...(options.cost ? { cost: options.cost } : {}),
      ...(options.now ? { now: options.now } : {}),
    },
  );
  return { data, secrets: secrets ? Object.keys(secrets).length : 0, unreadable };
}
