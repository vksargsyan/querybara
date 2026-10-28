import type { BsonValue, DocumentPath } from '@querybara/mongo-tools';
import { DropdownMenu } from 'radix-ui';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { formatCount } from '../../lib/format';
import { cachedProfile } from '../../state/data';
import { shortcutLabel } from '../../state/keybindings';
import {
  useCollectionState,
  type CollectionView,
  type PastQuery,
  type ViewSection,
} from '../../state/mongo/collection-view';
import { QUERY_FIELDS, type QueryField } from '../../state/mongo/query-bar';
import { useQueryBuilder } from '../../state/mongo/query-builder';
import { useResults } from '../../state/mongo/results';
import { useTheme } from '../theme';
import { Button, Icon, TAB, cx } from '../ui';
import { MenuItem, MenuSub } from '../MenuItem';
import { Pager } from '../Pager';
import { DOCUMENT_PAGE_SIZES, elapsed, queryTotal } from '../../state/mongo/pages';
import { CodeExportView } from './CodeExportDialog';
import { BulkDialog, DocumentEditorDialog } from './DocumentDialogs';
import { ExplainView } from './ExplainView';
import { defaultShellScript } from '../../state/mongo/explorer';
import { copyDocuments, openPasteDocuments } from '../../state/mongo/clipboard';
import { openMongoExport, openMongoImport } from '../../state/mongo/file-transfer';
import { openIntelliShell, openMongoSql, openMongoTool } from './open';
import { NameDialog } from './parts';
import { QueryBuilderPanel } from './QueryBuilderPanel';
import { ResultViews } from './ResultViews';
import { ResultViewSelect } from './ResultViewSelect';
import { ShellEditor } from './ShellEditor';

/**
 * A collection tab (spec §9, "Browsing and editing"), laid out as Studio 3T's (ADR 0036): the
 * breadcrumb, the query toolbar (Run, Open query in…, the Visual Query Builder), the query bar
 * (Query, Projection and Sort, Skip and Limit, and the find() text kept in step with them), and
 * the Result, Query Code and Explain sections. The result toolbar pages the documents, inserts
 * and opens the update and delete dialogs, and switches between Table, Tree and JSON View; the
 * footer counts. The builder docks at the right while it is open.
 */
export function CollectionPanel({ view }: { readonly view: CollectionView }) {
  const theme = useTheme();
  const section = useCollectionState(view, (s) => s.section);
  const notice = useCollectionState(view, (s) => s.notice);
  const readOnlyProfile = useCollectionState(view, (s) => s.readOnlyProfile);
  const production = useCollectionState(view, (s) => s.production);
  const active = useCollectionState(view, (s) => s.active);
  const builderOpen = useQueryBuilder(view.builder, (s) => s.mode === 'builder');
  const writable = view.target.kind !== 'view' && !readOnlyProfile;
  const { db, collection } = view.target;

  return (
    <div
      className="flex h-full flex-col bg-bg"
      data-testid="mongo-collection-panel"
      aria-label={`${db}.${collection} documents`}
    >
      <Breadcrumb view={view} />
      <QueryToolbar view={view} />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <QueryBar view={view} theme={theme} />
          {readOnlyProfile && (
            <Banner kind="info">
              This connection is read-only: documents can be viewed and copied, not changed.
            </Banner>
          )}
          {!readOnlyProfile && view.target.kind === 'view' && (
            <Banner kind="info">A view is read-only: its documents come from a pipeline.</Banner>
          )}
          {production && writable && (
            <Banner kind="warning">Production connection: every change asks before it runs.</Banner>
          )}
          {writable && active?.projection !== undefined && (
            <Banner kind="info">
              Read with a projection: clear it to edit or clone whole documents.
            </Banner>
          )}
          {notice && (
            <Banner
              kind={notice.kind === 'error' ? 'error' : 'info'}
              testId="mongo-notice"
              onDismiss={() => view.dismissNotice()}
            >
              {notice.text}
            </Banner>
          )}
          <Sections view={view} />
          <div className="flex min-h-0 flex-1 flex-col">
            {section === 'result' && <ResultSection view={view} writable={writable} />}
            {section === 'code' && <CodeSection view={view} />}
            {section === 'explain' && <ExplainSection view={view} />}
          </div>
          <Footer view={view} />
        </div>
        {builderOpen && (
          <aside
            aria-label="Visual Query Builder"
            className="flex w-[380px] shrink-0 flex-col border-l border-border bg-panel"
          >
            <div className="flex items-center gap-1.5 border-b border-border px-2 py-1 text-xs">
              <Icon name="builder" className="h-3.5 w-3.5 text-muted" />
              <span className="flex-1 font-medium">Visual Query Builder</span>
              <Button
                size="sm"
                variant="primary"
                aria-label="Run the built query"
                onClick={() => void view.run()}
              >
                <Icon name="play" className="h-3 w-3" />
                Run
              </Button>
              <button
                type="button"
                aria-label="Close the Visual Query Builder"
                className="rounded-sm p-0.5 text-muted hover:bg-hover hover:text-fg"
                onClick={() => view.builder.setMode('fields')}
              >
                <Icon name="close" className="h-3 w-3" />
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <QueryBuilderPanel view={view} docked />
            </div>
          </aside>
        )}
      </div>
      <DocumentEditorDialog view={view} theme={theme} />
      <BulkDialog view={view} theme={theme} />
    </div>
  );
}

/** "Connection › database › collection", with the collection's kind. */
function Breadcrumb({ view }: { readonly view: CollectionView }) {
  const { profileId, db, collection, kind } = view.target;
  const profile = cachedProfile(profileId);
  return (
    <div
      className="flex items-center gap-1.5 border-b border-border bg-panel px-3 py-1 text-xs"
      data-testid="mongo-collection-breadcrumb"
    >
      <Icon name="plug" className="h-3.5 w-3.5 text-muted" />
      <span>{profile?.name ?? 'MongoDB'}</span>
      <Icon name="chevron-right" className="h-3 w-3 text-faint" />
      <Icon name="database" className="h-3.5 w-3.5 text-lilac" />
      <span>{db}</span>
      <Icon name="chevron-right" className="h-3 w-3 text-faint" />
      <Icon name="table" className="h-3.5 w-3.5 text-muted" />
      <span className="font-medium text-fg">{collection}</span>
      {kind !== 'collection' && (
        <span className="rounded-sm bg-panel-2 px-1.5 text-[11px] text-muted">
          {kind === 'view' ? 'view' : 'time series'}
        </span>
      )}
    </div>
  );
}

const MENU =
  'z-50 min-w-56 rounded-md border border-border bg-raised p-1 text-[13px] shadow-widget';

function hint(label: string, detail: string): ReactNode {
  return (
    <span className="flex min-w-0 flex-col">
      <span>{label}</span>
      <span className="text-[11px] text-faint">{detail}</span>
    </span>
  );
}

/** Run (with findOne and count), Open query in…, Reset, Explain, the tools, and the builder. */
function QueryToolbar({ view }: { readonly view: CollectionView }) {
  const running = useCollectionState(view, (s) => s.running);
  const findText = useCollectionState(view, (s) => s.findText);
  const filter = useCollectionState(view, (s) => s.fields.filter);
  const builderOpen = useQueryBuilder(view.builder, (s) => s.mode === 'builder');
  const { profileId, db, collection, kind } = view.target;
  const target = { profileId, db, collection };
  return (
    <div
      className="flex flex-wrap items-center gap-1 border-b border-border bg-panel px-2 py-1"
      role="toolbar"
      aria-label="Collection"
    >
      <div className="flex">
        <Button
          size="sm"
          variant="primary"
          className="rounded-r-none"
          onClick={() => void view.run()}
          disabled={running}
          title="Run the query (Enter in a field, Ctrl/Cmd+Enter in the find() text)"
        >
          <Icon name="play" className="h-3.5 w-3.5" />
          Run
        </Button>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <Button
              size="sm"
              variant="primary"
              className="rounded-l-none border-l border-l-accent-fg/20 px-1"
              aria-label="Run options"
              disabled={running}
            >
              <Icon name="chevron-down" className="h-3 w-3" />
            </Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="start" sideOffset={4} className={MENU}>
              <MenuItem icon="play" onSelect={() => void view.run()}>
                {hint('find(…)', 'The documents the query matches, a page at a time')}
              </MenuItem>
              <MenuItem icon="play" onSelect={() => void view.run({ one: true })}>
                {hint('findOne(…)', 'The first document the query matches')}
              </MenuItem>
              <MenuItem icon="play" onSelect={() => void view.countExactly()}>
                {hint('count(…)', 'How many documents the query matches')}
              </MenuItem>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button size="sm" variant="ghost" title="Open the query in another tool">
            <Icon name="open" className="h-3.5 w-3.5" />
            Open query in…
            <Icon name="chevron-down" className="h-3 w-3" />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="start" sideOffset={4} className={MENU}>
            <MenuItem
              icon="shell"
              shortcut={shortcutLabel('mongo.openIntelliShell')}
              onSelect={() =>
                openIntelliShell({
                  profileId,
                  database: db,
                  text: findText.trim() === '' ? defaultShellScript(collection) : findText,
                })
              }
            >
              IntelliShell
            </MenuItem>
            <MenuItem
              icon="filter"
              shortcut={shortcutLabel('mongo.openAggregation')}
              onSelect={() =>
                openMongoTool({
                  tool: 'aggregation',
                  target: {
                    ...target,
                    ...(filter.trim() !== '' ? { text: `[{ $match: ${filter.trim()} }]` } : {}),
                  },
                })
              }
            >
              Aggregation Editor
            </MenuItem>
            <MenuItem
              icon="query"
              shortcut={shortcutLabel('mongo.openSql')}
              onSelect={() => openMongoSql({ profileId, db, collection })}
            >
              SQL Query
            </MenuItem>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <Button size="sm" variant="ghost" onClick={() => void view.reset()} title="Clear the query">
        <Icon name="restore" className="h-3.5 w-3.5" />
        Reset
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => void view.explain('executionStats')}
        title="Run the query and show its plan with execution statistics"
      >
        <Icon name="gauge" className="h-3.5 w-3.5" />
        Explain
      </Button>
      <QueryHistoryMenu view={view} />
      <SavedQueriesMenu view={view} />
      <span className="mx-1 h-4 w-px bg-border" />
      <CollectionTools view={view} kind={kind} />
      <span className="flex-1" />
      <Button
        size="sm"
        variant={builderOpen ? 'secondary' : 'ghost'}
        aria-pressed={builderOpen}
        onClick={() => view.builder.setMode(builderOpen ? 'fields' : 'builder')}
        title="Build the query by dragging fields; it stays in step with the query bar"
      >
        <Icon name="builder" className="h-3.5 w-3.5" />
        Visual Query Builder
      </Button>
    </div>
  );
}

/** The collection's past queries (Studio 3T's Query History), newest first; one runs again. */
function QueryHistoryMenu({ view }: { readonly view: CollectionView }) {
  const [entries, setEntries] = useState<readonly PastQuery[] | undefined>();
  return (
    <DropdownMenu.Root
      onOpenChange={(open) => {
        if (!open) return;
        setEntries(undefined);
        void view
          .queryHistory()
          .then(setEntries)
          .catch(() => setEntries([]));
      }}
    >
      <DropdownMenu.Trigger asChild>
        <Button size="sm" variant="ghost" title="Queries run on this collection">
          <Icon name="history" className="h-3.5 w-3.5" />
          History
          <Icon name="chevron-down" className="h-3 w-3" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          aria-label="Query history"
          className={cx(MENU, 'max-h-96 w-[30rem] overflow-auto')}
        >
          {entries === undefined && <p className="px-2 py-1.5 text-xs text-muted">Reading…</p>}
          {entries?.length === 0 && (
            <p className="px-2 py-1.5 text-xs text-muted">No query run on this collection yet.</p>
          )}
          {entries?.map((entry) => (
            <MenuItem key={entry.id} onSelect={() => void view.reuse(entry.text)}>
              <span className="flex min-w-0 flex-col">
                <span className={cx('truncate font-mono text-xs', entry.failed && 'text-danger')}>
                  {entry.text}
                </span>
                <span className="text-[11px] text-faint">
                  {new Date(entry.at).toLocaleString()}
                  {entry.failed ? ' · failed' : ''}
                </span>
              </span>
            </MenuItem>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** The collection's saved queries (Studio 3T's): open one, save the query in the bar, delete. */
function SavedQueriesMenu({ view }: { readonly view: CollectionView }) {
  const saved = useCollectionState(view, (s) => s.saved);
  const [naming, setNaming] = useState(false);
  useEffect(() => {
    void view.refreshSaved();
  }, [view]);
  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button size="sm" variant="ghost" title="Queries saved for this collection">
            <Icon name="bookmark" className="h-3.5 w-3.5" />
            Saved
            <Icon name="chevron-down" className="h-3 w-3" />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            sideOffset={4}
            aria-label="Saved queries"
            className={cx(MENU, 'max-h-96 w-80 overflow-auto')}
          >
            {saved.length === 0 && (
              <p className="px-2 py-1.5 text-xs text-muted">No saved queries yet.</p>
            )}
            {saved.map((entry) => (
              <MenuItem key={entry.id} icon="bookmark" onSelect={() => void view.reuse(entry.text)}>
                <span className="flex min-w-0 flex-col" title={entry.text}>
                  <span className="truncate">{entry.name}</span>
                  <span className="truncate font-mono text-[11px] text-faint">{entry.text}</span>
                </span>
              </MenuItem>
            ))}
            <DropdownMenu.Separator className="my-1 h-px bg-border" />
            <MenuItem icon="plus" onSelect={() => setNaming(true)}>
              Save Query…
            </MenuItem>
            {saved.length > 0 && (
              <MenuSub label="Delete Saved Query" icon="trash">
                {saved.map((entry) => (
                  <MenuItem key={entry.id} danger onSelect={() => void view.deleteSaved(entry.id)}>
                    {entry.name}
                  </MenuItem>
                ))}
              </MenuSub>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <NameDialog
        open={naming}
        title="Save the query"
        label="Name"
        initial=""
        confirmLabel="Save"
        onSubmit={(name) => {
          setNaming(false);
          void view.saveQuery(name);
        }}
        onClose={() => setNaming(false)}
      />
    </>
  );
}

/**
 * The collection's tools under one menu: indexes, schema analysis, options and the change
 * stream, each with its glyph and what it does.
 */
function CollectionTools(props: {
  readonly view: CollectionView;
  readonly kind: CollectionView['target']['kind'];
}) {
  const { profileId, db, collection } = props.view.target;
  const target = { profileId, db, collection };
  const { kind } = props;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button size="sm" variant="ghost" title="Indexes, schema, options, watch">
          <Icon name="wrench" className="h-3.5 w-3.5" />
          Tools
          <Icon name="chevron-down" className="h-3 w-3" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          aria-label="Collection tools"
          className={MENU}
        >
          {kind !== 'view' && (
            <MenuItem icon="key" onSelect={() => openMongoTool({ tool: 'indexes', target })}>
              {hint('Indexes', 'Create, hide and drop indexes')}
            </MenuItem>
          )}
          <MenuItem
            icon="chart"
            onSelect={() => openMongoTool({ tool: 'schema', target: { ...target, kind } })}
          >
            {hint('Schema', 'The fields, their types and how often they occur')}
          </MenuItem>
          <MenuItem icon="design" onSelect={() => openMongoTool({ tool: 'options', target })}>
            {hint('Options', 'Validation, collation and the collection’s settings')}
          </MenuItem>
          {kind !== 'view' && (
            <MenuItem
              icon="pulse"
              onSelect={() =>
                openMongoTool({
                  tool: 'changes',
                  target: { profileId, scope: { kind: 'collection', ns: { db, collection } } },
                })
              }
            >
              {hint('Watch', 'Follow inserts, updates and deletes as they happen')}
            </MenuItem>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

const LABELS: Readonly<Record<QueryField, string>> = {
  filter: 'Query',
  projection: 'Projection',
  sort: 'Sort',
  skip: 'Skip',
  limit: 'Limit',
};

const PLACEHOLDERS: Readonly<Record<QueryField, string>> = {
  filter: "{ status: 'shipped', total: { $gt: 100 } }",
  projection: '{ name: 1, total: 1 }',
  sort: '{ total: -1 }',
  skip: '0',
  limit: '0',
};

/** Where each field sits in Studio 3T's grid: Query alone, then Projection and Sort, Skip and Limit. */
const GRID: Readonly<Record<QueryField, string>> = {
  filter: 'col-span-2',
  projection: '',
  sort: '',
  skip: '',
  limit: '',
};

function QueryBar(props: { readonly view: CollectionView; readonly theme: 'dark' | 'light' }) {
  const { view } = props;
  const fields = useCollectionState(view, (s) => s.fields);
  const issues = useCollectionState(view, (s) => s.issues);
  const findText = useCollectionState(view, (s) => s.findText);
  const findIssue = useCollectionState(view, (s) => s.findIssue);
  const inputs = useRef<Partial<Record<QueryField, HTMLInputElement | null>>>({});
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void view.run();
    }
  };
  /** Puts the caret where the parser stopped. */
  const reveal = (field: QueryField, offset: number): void => {
    const input = inputs.current[field];
    input?.focus();
    input?.setSelectionRange(offset, offset + 1);
  };
  return (
    <div
      className="flex flex-col gap-1 border-b border-border bg-panel px-2 py-1.5"
      data-testid="mongo-query-bar"
    >
      <div className="grid grid-cols-2 gap-x-3 gap-y-1">
        {QUERY_FIELDS.map((field) => {
          const issue = issues[field];
          const id = `${view.id}-${field}`;
          return (
            <div key={field} className={cx('flex min-w-0 flex-col', GRID[field])}>
              <div className="flex items-center gap-2">
                <label
                  htmlFor={id}
                  className="w-[72px] shrink-0 text-right text-[11px] font-medium text-muted"
                >
                  {LABELS[field]}
                </label>
                <input
                  id={id}
                  ref={(element) => {
                    inputs.current[field] = element;
                  }}
                  value={fields[field]}
                  placeholder={PLACEHOLDERS[field]}
                  spellCheck={false}
                  aria-invalid={issue !== undefined}
                  data-testid={`mongo-${field}`}
                  className={cx(
                    'h-6 w-full min-w-0 rounded-sm border border-border bg-panel-2 px-2 font-mono text-xs text-fg',
                    'placeholder:text-muted/60 focus:border-accent focus:outline-none',
                    'aria-[invalid=true]:border-danger',
                  )}
                  onChange={(event) => view.setField(field, event.target.value)}
                  onKeyDown={onKeyDown}
                />
              </div>
              {issue && (
                <button
                  type="button"
                  role="alert"
                  data-testid={`mongo-${field}-issue`}
                  className="ml-[80px] truncate text-left text-[11px] text-danger hover:underline"
                  title={issue.message}
                  onClick={() => reveal(field, issue.offset)}
                >
                  {issue.message} (column {issue.column})
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex items-start gap-2">
        <span
          className="w-[72px] shrink-0 pt-1 text-right text-[11px] font-medium text-muted"
          title="The query as mongosh's find(): edit it here too"
        >
          find()
        </span>
        <div className="min-w-0 flex-1">
          <div className="h-[30px] rounded-sm border border-border">
            <ShellEditor
              value={findText}
              onChange={(text) => view.setFindText(text)}
              theme={props.theme}
              issue={findIssue}
              onRun={() => void view.run()}
              ariaLabel="find() text"
              testId="mongo-find-text"
            />
          </div>
          {findIssue && (
            <p role="alert" className="text-[11px] text-danger" data-testid="mongo-find-issue">
              {findIssue.message} (line {findIssue.line}, column {findIssue.column})
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

const SECTIONS: readonly { readonly value: ViewSection; readonly label: string }[] = [
  { value: 'result', label: 'Result' },
  { value: 'code', label: 'Query Code' },
  { value: 'explain', label: 'Explain' },
];

function Sections({ view }: { readonly view: CollectionView }) {
  const section = useCollectionState(view, (s) => s.section);
  return (
    <div
      className="flex items-center gap-0.5 border-b border-border bg-panel px-1"
      role="tablist"
      aria-label="Collection sections"
    >
      {SECTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          role="tab"
          aria-selected={section === option.value}
          className={TAB}
          onClick={() =>
            option.value === 'explain' && !view.state.explain
              ? void view.explain('executionStats')
              : view.setSection(option.value)
          }
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Studio 3T's result toolbar over the documents, then the documents. */
function ResultSection(props: { readonly view: CollectionView; readonly writable: boolean }) {
  const { view, writable } = props;
  const mode = useResults(view.results, (s) => s.mode);
  const loaded = useResults(view.results, (s) => s.documents.length);
  const loading = useResults(view.results, (s) => s.loading);
  const page = useCollectionState(view, (s) => s.page);
  const pageSize = useCollectionState(view, (s) => s.pageSize);
  const hasNext = useCollectionState(view, (s) => s.hasNext);
  const running = useCollectionState(view, (s) => s.running);
  const counting = useCollectionState(view, (s) => s.counting);
  const exactCount = useCollectionState(view, (s) => s.exactCount);
  const active = useCollectionState(view, (s) => s.active);
  const filtered = active !== undefined && Object.keys(active.filter).length > 0;
  const editable = writable && active?.projection === undefined;
  // The first page holds every document: the total is known without counting.
  const complete = page === 1 && !hasNext && !loading;
  const total =
    exactCount !== undefined && active !== undefined
      ? queryTotal(exactCount, active)
      : complete && !filtered
        ? loaded
        : undefined;
  const first = (page - 1) * pageSize + 1;
  const actions = useMemo(
    () =>
      writable
        ? {
            ...(editable
              ? {
                  edit: (index: number) => view.openEditor('edit', index),
                  clone: (index: number) => view.openEditor('clone', index),
                  setValue: (index: number, path: DocumentPath, value: BsonValue | undefined) =>
                    view.setValue(index, path, value),
                  removeField: (index: number, path: DocumentPath) =>
                    void view.removeField(index, path),
                }
              : {}),
            remove: (index: number) => void view.deleteDocument(index),
            insert: () => view.openEditor('insert'),
            copy: copyFrom(view),
            paste: () =>
              void openPasteDocuments(
                view.target.profileId,
                view.target.db,
                view.target.collection,
              ),
          }
        : { copy: copyFrom(view) },
    [view, writable, editable],
  );
  return (
    <>
      <div
        className="flex flex-wrap items-center gap-1 border-b border-border bg-panel px-2 py-0.5 text-xs"
        role="toolbar"
        aria-label="Result"
      >
        <button
          type="button"
          aria-label="Refresh"
          title="Run the query again"
          disabled={running}
          className="flex h-[20px] w-[22px] items-center justify-center rounded-sm text-muted hover:bg-hover hover:text-fg disabled:opacity-35"
          onClick={() => void view.run()}
        >
          <Icon name="refresh" className="h-3.5 w-3.5" />
        </button>
        <Pager
          page={page}
          pageSize={pageSize}
          pageSizes={DOCUMENT_PAGE_SIZES}
          hasNext={hasNext}
          total={total}
          busy={running || loading || counting}
          noun="documents"
          testId="mongo"
          onMove={(move) => void view.goToPage(move)}
          onPageSize={(size) => void view.setPageSize(size)}
        />
        <span className="px-1 text-muted" data-testid="mongo-range">
          {loaded === 0
            ? 'No documents'
            : `Documents ${formatCount(first)} to ${formatCount(first + loaded - 1)}`}
        </span>
        <span className="mx-1 h-4 w-px bg-border" />
        <Button
          size="sm"
          variant="ghost"
          disabled={!writable}
          onClick={() => view.openEditor('insert')}
          title={`Insert a document${shortcutText('mongo.insertDocument')}`}
        >
          <Icon name="plus" className="h-3.5 w-3.5" />
          Insert
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!writable}
          onClick={() => view.openBulk('update')}
          title={`Update the documents the query matches${shortcutText('mongo.updateDialog')}`}
        >
          <Icon name="edit" className="h-3.5 w-3.5" />
          Bulk update…
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-danger"
          disabled={!writable}
          onClick={() => view.openBulk('delete')}
          title={`Delete the documents the query matches${shortcutText('mongo.deleteDialog')}`}
        >
          <Icon name="trash" className="h-3.5 w-3.5" />
          Bulk delete…
        </Button>
        <span className="mx-1 h-4 w-px bg-border" />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void openMongoExport(view.fileExport())}
          title="Export what the query finds, or the whole collection, to a file"
        >
          <Icon name="export" className="h-3.5 w-3.5" />
          Export…
        </Button>
        {writable && view.target.kind !== 'view' && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void openMongoImport({
                profileId: view.target.profileId,
                db: view.target.db,
                collection: view.target.collection,
              })
            }
            title="Import a JSON, CSV or BSON file into this collection"
          >
            <Icon name="import" className="h-3.5 w-3.5" />
            Import…
          </Button>
        )}
        <span className="flex-1" />
        <ResultViewSelect
          value={mode}
          onChange={(next) => view.setView(next)}
          testId="mongo-view"
        />
      </div>
      <div className="min-h-0 flex-1">
        <ResultViews results={view.results} {...(actions ? { actions } : {})} />
      </div>
    </>
  );
}

/** Copies one loaded document, or all of them, for Paste Documents… (ADR 0036). */
function copyFrom(view: CollectionView): (index: number | 'all') => void {
  return (index) => {
    const documents = view.results.state.documents;
    const picked = index === 'all' ? documents : documents.slice(index, index + 1);
    copyDocuments(
      { profileId: view.target.profileId, db: view.target.db, collection: view.target.collection },
      picked,
    );
  };
}

/** The query as a program (Node.js, Python, Java, C#, Go, PHP), or as mongosh in IntelliShell. */
function CodeSection({ view }: { readonly view: CollectionView }) {
  const fields = useCollectionState(view, (s) => s.fields);
  const extras = useCollectionState(view, (s) => s.extras);
  const findText = useCollectionState(view, (s) => s.findText);
  // Built again when the query changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const request = useMemo(() => view.codeRequest(), [view, fields, extras]);
  if (!request) {
    return <p className="p-3 text-xs text-muted">Fix the query first to see it as code.</p>;
  }
  return (
    <CodeExportView
      request={request}
      fill
      actions={
        <Button
          variant="ghost"
          onClick={() =>
            openIntelliShell({
              profileId: view.target.profileId,
              database: view.target.db,
              text: findText,
            })
          }
        >
          <Icon name="shell" className="h-3.5 w-3.5" />
          Open in IntelliShell
        </Button>
      }
    />
  );
}

function ExplainSection({ view }: { readonly view: CollectionView }) {
  const explain = useCollectionState(view, (s) => s.explain);
  return (
    <>
      <div className="flex items-center gap-1 border-b border-border bg-panel px-2 py-0.5">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void view.explain('executionStats')}
          title="Run the query and show its plan with execution statistics"
        >
          <Icon name="gauge" className="h-3.5 w-3.5" />
          Run full explain
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void view.explain('queryPlanner')}
          title="Show the chosen plan without running the query"
        >
          <Icon name="diagram" className="h-3.5 w-3.5" />
          Plan only
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <ExplainView explain={explain} />
      </div>
    </>
  );
}

function shortcutText(commandId: string): string {
  const label = shortcutLabel(commandId);
  return label === undefined ? '' : ` (${label})`;
}

function Footer({ view }: { readonly view: CollectionView }) {
  const loaded = useResults(view.results, (s) => s.documents.length);
  const loading = useResults(view.results, (s) => s.loading);
  const estimate = useCollectionState(view, (s) => s.estimate);
  const exactCount = useCollectionState(view, (s) => s.exactCount);
  const counting = useCollectionState(view, (s) => s.counting);
  const durationMs = useCollectionState(view, (s) => s.durationMs);
  const filtered = useCollectionState(
    view,
    (s) => s.active !== undefined && Object.keys(s.active.filter).length > 0,
  );
  const page = useCollectionState(view, (s) => s.page);
  const hasNext = useCollectionState(view, (s) => s.hasNext);
  const complete = page === 1 && !hasNext && !loading;
  return (
    <footer className="flex flex-wrap items-center gap-2 border-t border-border bg-panel px-2 py-0.5 text-xs">
      <span data-testid="mongo-loaded" aria-live="polite">
        {formatCount(loaded)} {loaded === 1 ? 'document' : 'documents'} loaded
      </span>
      {loading && <span className="text-muted">· loading…</span>}
      <span className="text-muted" data-testid="mongo-total">
        ·{' '}
        {exactCount !== undefined
          ? `${formatCount(exactCount)} ${filtered ? 'matching' : 'in total'}`
          : complete && !filtered
            ? `${formatCount(loaded)} in total`
            : estimate === undefined
              ? 'estimating…'
              : estimate === null
                ? 'size unknown'
                : `≈ ${formatCount(estimate)} in the collection`}
      </span>
      <span className="flex-1" />
      {counting ? (
        <Button size="sm" variant="ghost" onClick={() => view.cancelCount()}>
          Counting… Cancel
        </Button>
      ) : (
        exactCount === undefined &&
        !(complete && !filtered) && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void view.countExactly()}
            data-testid="mongo-count"
          >
            <Icon name="check" className="h-3 w-3" />
            {filtered ? 'Count matches' : 'Count Documents'}
          </Button>
        )
      )}
      {durationMs !== undefined && (
        <span className="flex items-center gap-1 text-muted" title="The first page took">
          <Icon name="history" className="h-3 w-3" />
          {elapsed(durationMs)}
        </span>
      )}
    </footer>
  );
}

function Banner(props: {
  readonly kind: 'info' | 'warning' | 'error';
  readonly children: ReactNode;
  readonly testId?: string;
  readonly onDismiss?: () => void;
}) {
  return (
    <div
      role={props.kind === 'error' ? 'alert' : 'status'}
      data-testid={props.testId}
      className={cx(
        'flex items-center gap-2 border-b px-3 py-1 text-xs',
        props.kind === 'error' && 'border-danger/40 bg-danger/10 text-danger',
        props.kind === 'warning' && 'border-warning/30 bg-warning/10 text-warning',
        props.kind === 'info' && 'border-border bg-panel-2 text-fg',
      )}
    >
      {props.kind !== 'info' && <Icon name="warning" className="h-3.5 w-3.5" />}
      <span className="flex flex-1 flex-wrap items-center gap-2">{props.children}</span>
      {props.onDismiss && (
        <button
          type="button"
          aria-label="Dismiss"
          className="rounded p-0.5 hover:bg-hover"
          onClick={props.onDismiss}
        >
          <Icon name="close" className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}
