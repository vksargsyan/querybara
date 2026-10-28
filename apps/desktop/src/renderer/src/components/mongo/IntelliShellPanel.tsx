import {
  formatShellInline,
  fromEjson,
  fromFindQuery,
  type BsonDocument,
} from '@querybara/mongo-tools';
import { DropdownMenu } from 'radix-ui';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { formatCount } from '../../lib/format';
import { mainApi } from '../../lib/main-client';
import { useEditorAutosave } from '../../state/autosave';
import { useConnections } from '../../state/connections';
import { cachedProfile, useSettings } from '../../state/data';
import type { CodeExportRequest } from '../../state/mongo/code-export';
import {
  useIntelliShell,
  type IntelliShell,
  type RunMode,
  type ShellTab,
} from '../../state/mongo/intellishell';
import { useResults, type ResultMode } from '../../state/mongo/results';
import { usePanels } from '../../state/panels';
import type { monaco } from '../../lib/monaco';
import { useTheme } from '../theme';
import { Button, EnvironmentBadge, Icon, TAB, cx } from '../ui';
import { MenuItem } from '../MenuItem';
import { CodeExportDialog } from './CodeExportDialog';
import { IntelliShellEditor, type EditorPosition, type EditorScope } from './IntelliShellEditor';
import { openMongoCollection, openMongoTool } from './open';
import { ResultViews } from './ResultViews';
import { ResultViewSelect } from './ResultViewSelect';

/**
 * IntelliShell (ADR 0036), as Studio 3T lays it out: the connection and database breadcrumb, a
 * toolbar to run the whole script (F5), the statement at the cursor (F6) or the selection (F9),
 * the editor with mongosh's completions, and under it (or beside it) the raw shell output and a
 * tab per find() or aggregate() result, with the table, tree and JSON views.
 */
export function IntelliShellPanel({ shell }: { readonly shell: IntelliShell }) {
  const theme = useTheme();
  const settings = useSettings();
  const text = useIntelliShell(shell, (s) => s.text);
  const layout = useIntelliShell(shell, (s) => s.layout);
  const marker = useIntelliShell(shell, (s) => s.errorMarker);
  const database = useIntelliShell(shell, (s) => s.database);
  const title = usePanels((s) => s.panels[shell.id]?.title ?? '');
  const [position, setPosition] = useState<EditorPosition>({
    line: 1,
    column: 1,
    problem: undefined,
  });
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  const [split, setSplit] = useState(0.45);
  const area = useRef<HTMLDivElement>(null);
  useEditorAutosave(shell.id, {
    kind: 'mongo-console',
    profileId: shell.target.profileId,
    database: database ?? null,
    title,
    text,
    cursor: null,
  });

  /** The editor's cursor and selection, for the toolbar's run buttons. */
  const scope = (): EditorScope => {
    const instance = editor.current;
    const model = instance?.getModel();
    if (!instance || !model) return { cursor: 0 };
    const selection = instance.getSelection();
    const cursor = model.getOffsetAt(instance.getPosition() ?? { lineNumber: 1, column: 1 });
    if (!selection || selection.isEmpty()) return { cursor };
    return {
      cursor,
      selection: {
        start: model.getOffsetAt(selection.getStartPosition()),
        end: model.getOffsetAt(selection.getEndPosition()),
      },
    };
  };
  const run = (mode: RunMode, at: EditorScope = scope()): void => void shell.run(mode, at);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const element = area.current;
    if (!element) return;
    event.preventDefault();
    const box = element.getBoundingClientRect();
    const move = (moved: PointerEvent): void => {
      const ratio =
        layout === 'stacked'
          ? (moved.clientY - box.top) / box.height
          : (moved.clientX - box.left) / box.width;
      setSplit(Math.min(0.85, Math.max(0.15, ratio)));
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const stacked = layout === 'stacked';
  return (
    <div className="flex h-full flex-col bg-bg" data-testid="intellishell">
      <Breadcrumb shell={shell} />
      <Toolbar shell={shell} onRun={(mode) => run(mode)} />
      <div ref={area} className={cx('flex min-h-0 flex-1', stacked ? 'flex-col' : 'flex-row')}>
        <div
          className="flex min-h-0 min-w-0 flex-col"
          style={stacked ? { height: `${split * 100}%` } : { width: `${split * 100}%` }}
        >
          <div className="min-h-0 flex-1">
            <IntelliShellEditor
              shell={shell}
              value={text}
              theme={theme}
              fontSize={settings.data?.editor.fontSize ?? 13}
              issue={marker}
              onChange={(next) => shell.setText(next)}
              onRun={run}
              onPosition={setPosition}
              onEditor={(instance) => {
                editor.current = instance;
              }}
            />
          </div>
          <EditorStatus position={position} />
        </div>
        <div
          role="separator"
          aria-orientation={stacked ? 'horizontal' : 'vertical'}
          aria-label="Resize editor and results"
          className={cx(
            'shrink-0 border-border bg-panel hover:bg-focus',
            stacked ? 'h-1 cursor-row-resize border-y' : 'w-1 cursor-col-resize border-x',
          )}
          onPointerDown={startResize}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ResultArea shell={shell} />
        </div>
      </div>
      <Footer shell={shell} />
    </div>
  );
}

/** "Connection (host) › database": Studio 3T's breadcrumb, the database a list to switch. */
function Breadcrumb({ shell }: { readonly shell: IntelliShell }) {
  const database = useIntelliShell(shell, (s) => s.database);
  const databases = useIntelliShell(shell, (s) => s.databases);
  const running = useIntelliShell(shell, (s) => s.running);
  const readOnly = useIntelliShell(shell, (s) => s.readOnlyProfile);
  const profile = cachedProfile(shell.target.profileId);
  return (
    <div
      className="flex items-center gap-1.5 border-b border-border bg-panel px-3 py-1 text-xs"
      data-testid="intellishell-breadcrumb"
    >
      <Icon name="plug" className="h-3.5 w-3.5 text-muted" />
      <span className="text-fg">{profile?.name ?? 'MongoDB'}</span>
      <Icon name="chevron-right" className="h-3 w-3 text-faint" />
      <Icon name="database" className="h-3.5 w-3.5 text-lilac" />
      <select
        className="h-[20px] rounded-sm border border-transparent bg-transparent pr-1 text-xs text-fg hover:border-border focus:border-accent focus:outline-none"
        aria-label="Database"
        data-testid="intellishell-database"
        value={database ?? ''}
        disabled={running}
        onChange={(event) => void shell.useDatabase(event.target.value)}
      >
        {database === undefined && <option value="">(default)</option>}
        {[...new Set([...(database ? [database] : []), ...databases])].map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <span className="flex-1" />
      {readOnly && (
        <span className="flex items-center gap-1 rounded-sm bg-panel-2 px-1.5 py-0.5 text-[11px] text-muted">
          <Icon name="key" className="h-3 w-3" />
          Read-only
        </span>
      )}
    </div>
  );
}

function Toolbar(props: { readonly shell: IntelliShell; readonly onRun: (mode: RunMode) => void }) {
  const { shell } = props;
  const running = useIntelliShell(shell, (s) => s.running);
  const stopping = useIntelliShell(shell, (s) => s.stopping);
  const queryAssist = useIntelliShell(shell, (s) => s.queryAssist);
  const layout = useIntelliShell(shell, (s) => s.layout);
  const status = useIntelliShell(shell, (s) => s.status);
  return (
    <div
      className="flex flex-wrap items-center gap-1 border-b border-border bg-panel px-2 py-1"
      role="toolbar"
      aria-label="IntelliShell"
    >
      <Button
        size="sm"
        variant="primary"
        disabled={running || status === 'opening'}
        onClick={() => props.onRun('all')}
        title="Run the entire script (F5)"
        aria-label="Run entire script"
        data-testid="intellishell-run"
      >
        <Icon name="play" className="h-3.5 w-3.5" />
        Run
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={running || status === 'opening'}
        onClick={() => props.onRun('statement')}
        title="Run the statement at the cursor (F6)"
        aria-label="Run statement at cursor"
      >
        <Icon name="play-step" className="h-3.5 w-3.5" />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={running || status === 'opening'}
        onClick={() => props.onRun('selection')}
        title="Run the selection (F9)"
        aria-label="Run selection"
      >
        <Icon name="play-selection" className="h-3.5 w-3.5" />
      </Button>
      <Button
        size="sm"
        variant={running ? 'danger' : 'ghost'}
        disabled={!running || stopping}
        onClick={() => void shell.stop()}
        title="Stop the running script; the shell restarts if it does not stop"
        data-testid="intellishell-stop"
      >
        <Icon name="stop" className="h-3.5 w-3.5" />
        {stopping ? 'Stopping…' : 'Stop'}
      </Button>
      <span className="mx-1 h-4 w-px bg-border" />
      <Button
        size="sm"
        variant="ghost"
        disabled={running}
        onClick={() => shell.setText('')}
        title="Clear the editor"
      >
        <Icon name="plus" className="h-3.5 w-3.5" />
        New
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => void shell.openFile()}
        title="Open a script file"
      >
        <Icon name="folder-open" className="h-3.5 w-3.5" />
        Load script
      </Button>
      <SaveMenu shell={shell} />
      <ScriptHistory shell={shell} />
      <span className="mx-1 h-4 w-px bg-border" />
      <label
        className="flex items-center gap-1.5 rounded-sm px-1.5 text-xs text-fg hover:bg-hover"
        title="Open each find() and aggregate() in a result tab of its own, with exact types and paging"
      >
        <input
          type="checkbox"
          checked={queryAssist}
          onChange={(event) => shell.setQueryAssist(event.target.checked)}
          data-testid="intellishell-query-assist"
        />
        Query Assist
      </label>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => shell.toggleLayout()}
        title={layout === 'stacked' ? 'Results beside the editor' : 'Results under the editor'}
      >
        <Icon name="columns" className="h-3.5 w-3.5" />
        Change view
      </Button>
    </div>
  );
}

function SaveMenu({ shell }: { readonly shell: IntelliShell }) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button size="sm" variant="ghost" title="Save the script to a file">
          <Icon name="download" className="h-3.5 w-3.5" />
          Save script
          <Icon name="chevron-down" className="h-3 w-3" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          className="z-50 min-w-48 rounded-md border border-border bg-raised p-1 text-[13px] shadow-widget"
        >
          <MenuItem icon="download" onSelect={() => void shell.saveFile()}>
            Save
          </MenuItem>
          <MenuItem icon="download" onSelect={() => void shell.saveFile(true)}>
            Save as…
          </MenuItem>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** The connection's recent runs, to load one into the editor (Studio 3T's script history). */
function ScriptHistory({ shell }: { readonly shell: IntelliShell }) {
  const [entries, setEntries] = useState<readonly { id: string; text: string; at: string }[]>([]);
  return (
    <DropdownMenu.Root
      onOpenChange={(open) => {
        if (!open) return;
        void mainApi()
          .history.list({ profileId: shell.target.profileId, limit: 30 })
          .then((page) =>
            setEntries(page.entries.map((e) => ({ id: e.id, text: e.text, at: e.executedAt }))),
          )
          .catch(() => setEntries([]));
      }}
    >
      <DropdownMenu.Trigger asChild>
        <Button size="sm" variant="ghost" title="Scripts run on this connection">
          <Icon name="history" className="h-3.5 w-3.5" />
          Script history
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          className="z-50 max-h-96 w-[28rem] overflow-auto rounded-md border border-border bg-raised p-1 text-[13px] shadow-widget"
        >
          {entries.length === 0 && (
            <p className="px-2 py-1.5 text-xs text-muted">Nothing run yet.</p>
          )}
          {entries.map((entry) => (
            <MenuItem key={entry.id} onSelect={() => shell.setText(entry.text)}>
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-mono text-xs">{entry.text.split('\n')[0]}</span>
                <span className="text-[11px] text-faint">
                  {new Date(entry.at).toLocaleString()}
                </span>
              </span>
            </MenuItem>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function EditorStatus({ position }: { readonly position: EditorPosition }) {
  return (
    <div className="flex h-[20px] shrink-0 items-center gap-3 border-t border-border bg-panel px-2 text-[11px] text-muted">
      <span className="text-faint">
        F5 script · F6 statement · F9 selection · Ctrl+Space completions
      </span>
      <span className="flex-1" />
      <span>
        Ln {position.line}, Col {position.column}
      </span>
      {position.problem === undefined ? (
        <span className="text-success">No errors</span>
      ) : (
        <span className="max-w-[45%] truncate text-danger" title={position.problem}>
          {position.problem}
        </span>
      )}
    </div>
  );
}

/** The raw shell output and the result tabs under (or beside) the editor. */
function ResultArea({ shell }: { readonly shell: IntelliShell }) {
  const tabs = useIntelliShell(shell, (s) => s.tabs);
  const active = useIntelliShell(shell, (s) => s.active);
  const current = tabs.find((tab) => tab.id === active);
  return (
    <>
      <div
        className="flex items-center gap-0.5 overflow-x-auto border-b border-border bg-panel px-1"
        role="tablist"
        aria-label="Results"
      >
        <button
          type="button"
          role="tab"
          aria-selected={active === 'raw'}
          className={TAB}
          onClick={() => shell.setActive('raw')}
          data-testid="intellishell-raw-tab"
        >
          <Icon name="shell" className="h-3.5 w-3.5" />
          Raw shell output
        </button>
        {tabs.map((tab) => (
          <span key={tab.id} className="flex items-center">
            <button
              type="button"
              role="tab"
              aria-selected={active === tab.id}
              className={TAB}
              onClick={() => shell.setActive(tab.id)}
              title={tab.source}
              data-testid="intellishell-result-tab"
            >
              {tab.title}
            </button>
            <button
              type="button"
              aria-label={tab.pinned ? `Unpin ${tab.title}` : `Pin ${tab.title}`}
              aria-pressed={tab.pinned}
              title={
                tab.pinned ? 'Pinned: the next run keeps it' : 'Pin it so the next run keeps it'
              }
              className={cx(
                'rounded-sm p-0.5 hover:bg-hover',
                tab.pinned ? 'text-accent' : 'text-faint',
              )}
              onClick={() => shell.togglePin(tab.id)}
            >
              <Icon name="pin" className="h-3 w-3" />
            </button>
            <button
              type="button"
              aria-label={`Close ${tab.title}`}
              className="mr-1 rounded-sm p-0.5 text-faint hover:bg-hover hover:text-fg"
              onClick={() => void shell.closeTab(tab.id)}
            >
              <Icon name="close" className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
      {current ? <ResultTab shell={shell} tab={current} /> : <RawOutput shell={shell} />}
    </>
  );
}

function RawOutput({ shell }: { readonly shell: IntelliShell }) {
  const output = useIntelliShell(shell, (s) => s.output);
  const pinNew = useIntelliShell(shell, (s) => s.pinNew);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [output]);
  return (
    <>
      <div className="flex items-center gap-1 border-b border-border bg-panel px-2 py-0.5">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void shell.restart()}
          title="Start a new shell"
        >
          <Icon name="refresh" className="h-3.5 w-3.5" />
          Restart shell
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => shell.clearOutput()}
          title="Clear (or type cls)"
        >
          <Icon name="discard" className="h-3.5 w-3.5" />
          Clear raw shell output
        </Button>
        <label className="flex items-center gap-1.5 rounded-sm px-1.5 text-xs hover:bg-hover">
          <input
            type="checkbox"
            checked={pinNew}
            onChange={(event) => shell.setPinNew(event.target.checked)}
          />
          Pin new results
        </label>
      </div>
      <div
        className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-xs select-text"
        data-testid="intellishell-output"
        aria-live="polite"
      >
        {output.length === 0 && (
          <p className="text-muted">
            Run a script to see what it prints here. find() and aggregate() results open in tabs of
            their own while Query Assist is on.
          </p>
        )}
        {output.map((line) => (
          <pre
            key={line.id}
            className={cx(
              'whitespace-pre-wrap',
              line.kind === 'input' && 'mt-1 text-faint',
              line.kind === 'error' && 'text-danger',
              line.kind === 'info' && 'text-muted italic',
            )}
          >
            {line.text}
          </pre>
        ))}
        <div ref={end} />
      </div>
    </>
  );
}

/** One result tab: its documents with Studio 3T's result toolbar. */
function ResultTab({ shell, tab }: { readonly shell: IntelliShell; readonly tab: ShellTab }) {
  const count = useResults(tab.results, (s) => s.documents.length);
  const hasMore = useResults(tab.results, (s) => s.hasMore);
  const loading = useResults(tab.results, (s) => s.loading);
  const mode = useResults(tab.results, (s) => s.mode);
  const [exporting, setExporting] = useState<CodeExportRequest | undefined>();
  const { ns, query } = tab;
  const openCollection = (): void => {
    if (!ns || query?.kind !== 'find') return;
    const field = (ejson: string | undefined): string =>
      ejson === undefined ? '' : formatShellInline(fromEjson(ejson, 'query'));
    openMongoCollection(
      {
        profileId: shell.target.profileId,
        db: ns.db,
        collection: ns.collection,
        kind: 'collection',
      },
      {
        filter: query.query.filter === '{}' ? '' : field(query.query.filter),
        projection: field(query.query.projection),
        sort: field(query.query.sort),
        skip: query.query.skip === undefined ? '' : String(query.query.skip),
        limit: query.query.limit === undefined ? '' : String(query.query.limit),
      },
    );
  };
  const openPipeline = (): void => {
    if (!ns || query?.kind !== 'aggregate') return;
    openMongoTool(
      {
        tool: 'aggregation',
        target: {
          profileId: shell.target.profileId,
          db: ns.db,
          collection: ns.collection,
          text: formatShellInline(fromEjson(query.pipeline, 'pipeline')),
        },
      },
      { replace: true },
    );
  };
  const exportCode = (): void => {
    if (!ns || !query) return;
    setExporting({
      database: ns.db,
      target:
        query.kind === 'find'
          ? { kind: 'find', collection: ns.collection, query: fromFindQuery(query.query) }
          : {
              kind: 'aggregate',
              collection: ns.collection,
              pipeline: fromEjson(query.pipeline, 'pipeline') as BsonDocument[],
            },
    });
  };
  return (
    <>
      <div className="flex flex-wrap items-center gap-1 border-b border-border bg-panel px-2 py-0.5 text-xs">
        <span className="px-1 text-muted" data-testid="intellishell-result-count">
          {count === 0 ? 'No documents' : `Documents 1 to ${formatCount(count)}`}
          {hasMore ? ' (more)' : ''}
        </span>
        {hasMore && (
          <Button
            size="sm"
            variant="ghost"
            disabled={loading}
            onClick={() => void shell.fetchMore(tab.id)}
          >
            {loading ? 'Loading…' : 'Fetch more'}
          </Button>
        )}
        <span className="mx-1 h-4 w-px bg-border" />
        {query?.kind === 'find' && ns && (
          <Button
            size="sm"
            variant="ghost"
            onClick={openCollection}
            title="Open the query in a collection tab, to page and edit"
          >
            <Icon name="table" className="h-3.5 w-3.5" />
            Open in collection tab
          </Button>
        )}
        {query?.kind === 'aggregate' && ns && (
          <Button size="sm" variant="ghost" onClick={openPipeline}>
            <Icon name="filter" className="h-3.5 w-3.5" />
            Open in Aggregation Editor
          </Button>
        )}
        {query && ns && (
          <Button
            size="sm"
            variant="ghost"
            onClick={exportCode}
            title="The query as a program for a driver"
          >
            <Icon name="export" className="h-3.5 w-3.5" />
            Query code…
          </Button>
        )}
        <span className="flex-1" />
        {!tab.exactTypes && (
          <span
            className="text-[11px] text-muted"
            title="The shell read this cursor itself (a map(), or a cursor already read): numbers show as the shell sees them"
          >
            Types as the shell sees them
          </span>
        )}
        <span className="text-[11px] text-faint">{tab.durationMs} ms</span>
        <ResultViewSelect value={mode} onChange={(next: ResultMode) => tab.results.setMode(next)} />
      </div>
      <div className="min-h-0 flex-1">
        <ResultViews results={tab.results} />
      </div>
      <CodeExportDialog request={exporting} onClose={() => setExporting(undefined)} />
    </>
  );
}

function Footer({ shell }: { readonly shell: IntelliShell }) {
  const status = useIntelliShell(shell, (s) => s.status);
  const error = useIntelliShell(shell, (s) => s.error);
  const running = useIntelliShell(shell, (s) => s.running);
  const lastRun = useIntelliShell(shell, (s) => s.lastRun);
  const versions = useIntelliShell(shell, (s) =>
    s.mongoshVersion ? `mongosh ${s.mongoshVersion} · MongoDB ${s.serverVersion ?? ''}` : undefined,
  );
  const connection = useConnections((s) => s.byProfile[shell.target.profileId]);
  const profile = cachedProfile(shell.target.profileId);
  return (
    <footer className="flex h-[22px] shrink-0 items-center gap-2 border-t border-border bg-panel px-2 text-[11px] text-muted">
      {profile && (
        <span className="flex items-center gap-1.5">
          <EnvironmentBadge environment={profile.presentation.environment} />
          {profile.name}
        </span>
      )}
      {versions && <span>· {versions}</span>}
      <span className="flex-1" />
      {status === 'failed' && error && (
        <span className="truncate text-danger" title={error}>
          {error}
        </span>
      )}
      {running ? (
        <span>Running…</span>
      ) : (
        lastRun && (
          <span data-testid="intellishell-last-run">
            {lastRun.status === 'success'
              ? 'Ran'
              : lastRun.status === 'cancelled'
                ? 'Stopped after'
                : 'Failed after'}{' '}
            {lastRun.ran} {lastRun.ran === 1 ? 'statement' : 'statements'} in {lastRun.durationMs}{' '}
            ms
          </span>
        )
      )}
      <span>
        {status === 'opening'
          ? 'Starting the shell…'
          : connection?.status === 'ready'
            ? 'Connected'
            : (connection?.status ?? 'Not connected')}
      </span>
    </footer>
  );
}
