import type { MongoCollectionChange } from '@querybara/ipc';
import { formatShell, formatShellInline, fromEjson } from '@querybara/mongo-tools';

import { useCollectionHistory, type CollectionHistory } from '../../state/mongo/collection-history';
import { Button, Icon, cx } from '../ui';
import { NoticeBanner, RulesBanners } from './parts';

/**
 * Studio 3T's Collection History (ADR 0041): the documents changed through the collection tab,
 * newest first, each with the document before and after, and Undo.
 */

const OPERATION_LABELS: Readonly<Record<MongoCollectionChange['operation'], string>> = {
  insert: 'Inserted',
  update: 'Edited',
  delete: 'Deleted',
};

function shown(document: string | null): string {
  if (document === null) return '';
  try {
    return formatShell(fromEjson(document));
  } catch {
    return document;
  }
}

function idText(documentId: string): string {
  try {
    return formatShellInline(fromEjson(documentId));
  } catch {
    return documentId;
  }
}

export function CollectionHistoryPanel({ panel }: { readonly panel: CollectionHistory }) {
  const changes = useCollectionHistory(panel, (s) => s.changes);
  const loading = useCollectionHistory(panel, (s) => s.loading);
  const selectedId = useCollectionHistory(panel, (s) => s.selected);
  const writeRules = useCollectionHistory(panel, (s) => s.writeRules);
  const notice = useCollectionHistory(panel, (s) => s.notice);
  const selected = changes.find((change) => change.id === selectedId);
  const { db, collection } = panel.target;
  return (
    <div className="flex h-full flex-col" data-testid="mongo-collection-history">
      <div
        className="flex flex-wrap items-center gap-1 border-b border-border bg-panel px-2 py-1"
        role="toolbar"
        aria-label="Collection History"
      >
        <span className="mr-2 text-xs font-semibold">Collection History</span>
        <span className="font-mono text-xs text-muted">
          {db}.{collection}
        </span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" disabled={loading} onClick={() => void panel.refresh()}>
          <Icon name="refresh" className="h-3.5 w-3.5" />
          Refresh
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={changes.length === 0}
          onClick={() => void panel.clear()}
        >
          <Icon name="trash" className="h-3.5 w-3.5" />
          Clear history
        </Button>
      </div>
      <RulesBanners rules={writeRules} what="undoing a change" />
      <NoticeBanner notice={notice} onDismiss={() => panel.dismissNotice()} />
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <ul
          className="min-h-0 overflow-auto border-r border-border text-xs"
          aria-label="Changes"
          role="listbox"
        >
          {changes.map((change) => (
            <li
              key={change.id}
              role="option"
              aria-selected={change.id === selectedId}
              data-operation={change.operation}
              className={cx(
                'flex cursor-default items-center gap-2 border-b border-border/60 px-2 py-1 hover:bg-hover',
                change.id === selectedId && 'bg-accent/15',
              )}
              onClick={() => panel.select(change.id)}
            >
              <span className="w-16 shrink-0 font-medium">
                {OPERATION_LABELS[change.operation]}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono">{idText(change.documentId)}</span>
              {change.revertedAt !== null && <span className="text-muted">undone</span>}
              <time className="shrink-0 text-muted" dateTime={change.changedAt}>
                {new Date(change.changedAt).toLocaleString()}
              </time>
            </li>
          ))}
          {changes.length === 0 && !loading && (
            <li className="px-2 py-3 text-muted">
              No changes yet: documents inserted, edited or deleted in the collection tab show here.
            </li>
          )}
        </ul>
        {selected ? (
          <section className="flex min-h-0 flex-col" aria-label="The change">
            <div className="flex items-center gap-2 border-b border-border bg-panel px-2 py-1 text-xs">
              <span className="font-mono">{panel.undoCommand(selected)}</span>
              <span className="flex-1" />
              <Button
                size="sm"
                variant="primary"
                disabled={selected.revertedAt !== null || writeRules.readOnlyProfile}
                onClick={() => void panel.undo(selected)}
              >
                <Icon name="undo" className="h-3.5 w-3.5" />
                Undo
              </Button>
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-2">
              <DocumentVersion title="Before" document={selected.before} />
              <DocumentVersion title="After" document={selected.after} />
            </div>
          </section>
        ) : (
          <div />
        )}
      </div>
    </div>
  );
}

function DocumentVersion(props: { readonly title: string; readonly document: string | null }) {
  return (
    <section
      className="flex min-h-0 flex-col border-r border-border last:border-r-0"
      aria-label={props.title}
    >
      <h3 className="border-b border-border bg-panel px-2 py-0.5 text-[11px] text-muted">
        {props.title}
      </h3>
      <pre className="min-h-0 flex-1 overflow-auto px-2 py-1 font-mono text-xs">
        {props.document === null ? (
          <span className="text-muted">(none)</span>
        ) : (
          shown(props.document)
        )}
      </pre>
    </section>
  );
}
