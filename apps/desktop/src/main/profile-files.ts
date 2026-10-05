import { readFile, stat, writeFile } from 'node:fs/promises';

import { QuerybaraError, secretRefsOf } from '@querybara/core';
import type { HandlersOf, mainContract } from '@querybara/ipc';
import {
  CONNECTIONS_FILE_LIMIT,
  applyConnectionsImport,
  connectionsFileFormat,
  existingProfileFor,
  exportConnections,
  readConnectionsFile,
  type ConnectionsFile,
  type Store,
  type StoredProfile,
} from '@querybara/storage';

import type { FileGrants } from './jobs-api';

type ProfileHandlers = HandlersOf<typeof mainContract>['profiles'];

/**
 * Importing and exporting connections in the desktop app (spec §4): a Querybara export, or a
 * Navicat `.ncx` file. The file is read in main, so the secrets it holds never reach the
 * renderer: `inspectFile` sends the profiles and a count of their secrets, and `importFile`
 * reads the file again to save the entries the user chose. Files are only those the window
 * picked in a dialog.
 */
export function profileFileHandlers(
  store: Store,
  files: FileGrants,
): Pick<ProfileHandlers, 'inspectFile' | 'importFile' | 'exportFile'> {
  const read = async (path: string, passphrase: string | undefined): Promise<ConnectionsFile> => {
    files.checkRead(path);
    return readConnectionsFile(await readLimited(path), passphrase ? { passphrase } : {});
  };

  return {
    inspectFile: async ({ path, passphrase }) => {
      files.checkRead(path);
      const data = await readLimited(path);
      const format = connectionsFileFormat(data);
      if (format === 'querybara' && !passphrase) {
        return { format, locked: true, entries: [], skipped: [] };
      }
      const file = readConnectionsFile(data, passphrase ? { passphrase } : {});
      const profiles = store.profiles.list();
      const folders = folderPaths(file);
      return {
        format: file.format,
        locked: false,
        ...(file.exportedAt !== undefined ? { exportedAt: file.exportedAt } : {}),
        entries: file.entries.map((entry) => {
          const existing = existingProfileFor(file, entry, profiles);
          const folder = folders.get(entry.profile.presentation.folderId ?? '');
          return {
            key: entry.key,
            profile: entry.profile,
            ...(existing ? { existing: { id: existing.id, name: existing.name } } : {}),
            ...(folder !== undefined ? { folder } : {}),
            savedLogins: secretRefsOf(entry.profile).filter((ref) =>
              Object.hasOwn(file.secrets, ref.id),
            ).length,
            notes: [...entry.notes],
          };
        }),
        skipped: [...file.skipped],
      };
    },

    importFile: async ({ path, passphrase, keys, replace }) => {
      const file = await read(path, passphrase);
      const result = applyConnectionsImport(store, file, { keys, replace });
      return {
        added: result.added,
        replaced: result.replaced,
        skipped: result.skipped,
        savedLogins: result.savedSecrets,
        unsavedLogins: result.unsavedSecrets,
        profileIds: result.written.map((w) => w.profileId),
      };
    },

    exportFile: async ({ path, profileIds, passphrase, includeSecrets }) => {
      files.checkWrite(path);
      const profiles: StoredProfile[] = profileIds.map((id) => {
        const profile = store.profiles.get(id);
        if (!profile) {
          throw new QuerybaraError({ code: 'NOT_FOUND', message: `Profile ${id} was not found` });
        }
        return profile;
      });
      const exported = exportConnections(store, profiles, { passphrase, includeSecrets });
      await writeFile(path, exported.data, { mode: 0o600 });
      return {
        profiles: profiles.length,
        logins: exported.secrets,
        unreadable: exported.unreadable,
      };
    },
  };
}

async function readLimited(path: string): Promise<Uint8Array> {
  if ((await stat(path)).size > CONNECTIONS_FILE_LIMIT) {
    throw new QuerybaraError({
      code: 'VALIDATION_FAILED',
      message: 'The file is too large to be a connections file',
    });
  }
  return readFile(path);
}

/** Each exported folder's path from the root, by folder id ("Shop / Production"). */
function folderPaths(file: ConnectionsFile): Map<string, string> {
  const paths = new Map<string, string>();
  // Parents come first, so a folder's parent path is known when it is reached.
  for (const folder of file.folders) {
    const parent = folder.parentId === null ? undefined : paths.get(folder.parentId);
    paths.set(folder.id, parent === undefined ? folder.name : `${parent} / ${folder.name}`);
  }
  return paths;
}
