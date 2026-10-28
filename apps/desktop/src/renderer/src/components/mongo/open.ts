import { AggregationEditor } from '../../state/mongo/aggregation';
import { CollectionView, type CollectionTarget } from '../../state/mongo/collection-view';
import {
  createCollectionPanel,
  createShellPanel,
  createSqlPanel,
  createToolPanel,
  getMongoPanel,
  type ToolPanelRequest,
} from '../../state/mongo/panels';
import type { QueryFields } from '../../state/mongo/query-bar';
import { starterSql } from '../../state/mongo/sql-query';
import { UsersRoles } from '../../state/mongo/users';
import { cachedProfile } from '../../state/data';
import { currentDock } from '../dock';

/**
 * Opens the MongoDB module's panels in the dock: a collection's view (or focuses the open one),
 * an IntelliShell (the "query tab" of a MongoDB connection, ADR 0036), a SQL tab and the tool
 * panels.
 */

function addToDock(id: string, title: string): void {
  currentDock()?.addPanel({
    id,
    component: 'mongo',
    tabComponent: 'panelTab',
    title,
    params: { panelId: id },
    renderer: 'always',
  });
}

/**
 * Opens a collection, view or time series collection in the collection view. With `fields` the
 * query bar starts from them and runs them, in a view already open too.
 */
export function openMongoCollection(target: CollectionTarget, fields?: QueryFields): string {
  const { id, opened } = createCollectionPanel(target, fields);
  if (opened) {
    addToDock(id, target.collection);
    return id;
  }
  currentDock()?.getPanel(id)?.api.setActive();
  const view = getMongoPanel(id);
  if (fields && view instanceof CollectionView) void view.applyFields(fields);
  return id;
}

/**
 * Opens an IntelliShell on a connection, optionally in a database and with a script. Its tab is
 * "IntelliShell: <connection>" as in Studio 3T; a script opened from a collection starts with
 * that collection's find().
 */
export function openIntelliShell(options: {
  readonly profileId: string;
  readonly database?: string;
  readonly text?: string;
  readonly title?: string;
  /** Runs the text as soon as the shell is up. */
  readonly run?: boolean;
}): string {
  const profile = cachedProfile(options.profileId);
  const title = options.title ?? `IntelliShell: ${profile?.name ?? options.database ?? 'MongoDB'}`;
  const id = createShellPanel(
    {
      profileId: options.profileId,
      database: options.database,
      ...(options.text !== undefined ? { text: options.text } : {}),
      ...(options.run ? { run: true } : {}),
    },
    title,
  );
  addToDock(id, title);
  return id;
}

/**
 * Opens a SQL tab on a database: empty, with `text`, or with a starter query on `collection`.
 */
export function openMongoSql(options: {
  readonly profileId: string;
  readonly db: string;
  readonly collection?: string;
  readonly text?: string;
  readonly title?: string;
}): string {
  const title = options.title ?? `${options.collection ?? options.db} SQL`;
  const text =
    options.text ?? (options.collection === undefined ? '' : starterSql(options.collection));
  const id = createSqlPanel({ profileId: options.profileId, db: options.db, text }, title);
  addToDock(id, title);
  return id;
}

/**
 * Opens a MongoDB tool panel (aggregation editor, indexes, schema, options, change stream,
 * GridFS files, users and roles), or focuses the one already open on the same object. With
 * `replace`, an aggregation editor already open takes the request's pipeline text instead of
 * keeping its own.
 */
export function openMongoTool(
  request: ToolPanelRequest,
  options: { readonly replace?: boolean } = {},
): string {
  const { id, opened, title } = createToolPanel(request);
  if (opened) {
    addToDock(id, title);
    return id;
  }
  currentDock()?.getPanel(id)?.api.setActive();
  const panel = getMongoPanel(id);
  if (
    options.replace === true &&
    request.tool === 'aggregation' &&
    request.target.text !== undefined &&
    panel instanceof AggregationEditor
  ) {
    panel.setText(request.target.text);
  }
  if (request.tool === 'users' && panel instanceof UsersRoles) {
    panel.setTab(request.target.tab);
    if (request.target.select !== undefined) {
      if (request.target.tab === 'users') panel.selectUser(request.target.select);
      else panel.selectRole(request.target.select);
    }
  }
  return id;
}
