import { ShellParseError, type BsonDocument } from '@querybara/mongo-tools';
import { useMemo, useState } from 'react';

import { errorMessage } from '../../lib/errors';
import {
  closePasteDocuments,
  documentsText,
  pasteDocuments,
  pastedDocuments,
  refreshCollections,
  useMongoClipboard,
  type PasteTarget,
} from '../../state/mongo/clipboard';
import { useTheme } from '../theme';
import { Button, Modal } from '../ui';
import { ShellEditor } from './ShellEditor';

/**
 * Paste Documents… (ADR 0036): the documents copied in Querybara, in mongosh syntax, ready to
 * insert into the collection; text copied from elsewhere (mongosh, Extended JSON, one document
 * or an array) can be pasted over them. Each document may keep its `_id` or get a new one.
 */
export function PasteDocumentsDialog() {
  const target = useMongoClipboard((s) => s.paste);
  if (!target) return null;
  return <PasteDialog target={target} />;
}

function PasteDialog({ target }: { readonly target: PasteTarget }) {
  const clipboard = useMongoClipboard((s) => s.clipboard);
  const theme = useTheme();
  const [text, setText] = useState(() =>
    clipboard?.kind === 'documents' ? documentsText(clipboard.documents) : '',
  );
  const [newIds, setNewIds] = useState(
    // Pasting back where they came from would only collide on every _id.
    clipboard?.kind === 'documents' &&
      clipboard.profileId === target.profileId &&
      clipboard.db === target.db &&
      clipboard.collection === target.collection,
  );
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const parsed = useMemo((): {
    readonly documents?: BsonDocument[];
    readonly error?: string;
    readonly offset?: number;
  } => {
    if (text.trim() === '') return { error: 'Paste one document, or an array of them' };
    try {
      return { documents: pastedDocuments(text, newIds) };
    } catch (problem) {
      return {
        error: errorMessage(problem),
        ...(problem instanceof ShellParseError ? { offset: problem.offset } : {}),
      };
    }
  }, [text, newIds]);
  const count = parsed.documents?.length ?? 0;
  const paste = async (): Promise<void> => {
    if (!parsed.documents) return;
    setBusy(true);
    setError(undefined);
    try {
      const inserted = await pasteDocuments(target, parsed.documents);
      if (inserted !== undefined) {
        refreshCollections(target.profileId, target.db);
        closePasteDocuments();
      }
    } catch (problem) {
      setError(errorMessage(problem));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onOpenChange={(open) => !open && closePasteDocuments()}
      title={`Paste documents into ${target.collection}`}
      description={`${target.profileName} · ${target.db}`}
      width="w-[720px]"
      footer={
        <>
          <span
            className="mr-auto self-center text-xs text-danger"
            role={error ? 'alert' : undefined}
          >
            {error ?? ''}
          </span>
          <Button variant="ghost" onClick={closePasteDocuments}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || count === 0 || target.readOnly}
            title={target.readOnly ? 'This connection is read-only' : parsed.error}
            onClick={() => void paste()}
          >
            {count > 1 ? `Paste ${count} documents` : 'Paste'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2 text-xs" data-testid="paste-documents">
        <p className="text-muted">
          {clipboard?.kind === 'documents'
            ? `Copied from ${clipboard.db}.${clipboard.collection}. Edit them, or paste other documents over them.`
            : 'Paste one document or an array of them: mongosh text or Extended JSON.'}
        </p>
        <div className="h-72 rounded border border-border">
          <ShellEditor
            value={text}
            onChange={setText}
            theme={theme}
            ariaLabel="Documents to paste"
            testId="paste-documents-text"
            className="h-full"
            {...(parsed.offset !== undefined && parsed.error !== undefined
              ? { issue: { offset: parsed.offset, message: parsed.error } }
              : {})}
          />
        </div>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={newIds}
            onChange={(event) => setNewIds(event.target.checked)}
          />
          Give each document a new _id
        </label>
        <p
          className={parsed.error ? 'text-danger' : 'text-muted'}
          data-testid="paste-documents-status"
        >
          {parsed.error ??
            `${count} ${count === 1 ? 'document' : 'documents'} to insert into ${target.db}.${target.collection}`}
        </p>
      </div>
    </Modal>
  );
}
