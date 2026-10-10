import type { StoredProfile } from '@querybara/ipc';
import { describe, expect, it } from 'vitest';

import {
  buildExportJob,
  ExportWizard,
  type ExportWizardApi,
} from '../src/renderer/src/state/export-wizard';
import { rememberResultSource, resultSource } from '../src/renderer/src/state/result-sources';
import { openExportQuery, useTransferDialogs } from '../src/renderer/src/state/transfer-dialogs';

/**
 * "Export results…" runs the statement again in the job runner, on a session of its own: the
 * job connects to the database the statement ran in, or MySQL answers "No database selected".
 */

const ERP = { id: 'p1', name: 'ERP', engine: 'mysql' } as unknown as StoredProfile;

function exportSource() {
  const dialog = useTransferDialogs.getState().dialog;
  if (dialog?.kind !== 'export') throw new Error('The export wizard is not open');
  return dialog.source;
}

describe('export of a query result', () => {
  it('connects the job to the database the statement ran in', async () => {
    rememberResultSource('run1', 0, 'SELECT * FROM orders', [], 'erp');
    const source = resultSource('run1:0:0');
    expect(source).toEqual({ text: 'SELECT * FROM orders', params: [], database: 'erp' });
    openExportQuery(ERP, source!);
    expect(exportSource()).toMatchObject({ kind: 'query', database: 'erp' });

    const api: ExportWizardApi = {
      saveFile: async (options) => `/out/${options.defaultName}`,
      openDirectory: async () => '/out',
      start: async () => 'job-1',
    };
    const wizard = new ExportWizard(exportSource(), api);
    wizard.next();
    await wizard.chooseDestination();
    expect(buildExportJob(wizard.state)).toMatchObject({
      profileId: 'p1',
      database: 'erp',
      source: { kind: 'query', text: 'SELECT * FROM orders' },
    });
  });

  it("leaves the connection's default database when the tab had none", () => {
    rememberResultSource('run2', 0, 'SELECT 1', [], undefined);
    openExportQuery(ERP, resultSource('run2:0:0')!);
    expect(exportSource().database).toBeUndefined();
  });
});
