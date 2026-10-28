import type { BrowseNode } from '@querybara/core';
import type { StoredProfile } from '@querybara/ipc';
import { collectionReference, formatShellInline, fromEjson } from '@querybara/mongo-tools';
import { DropdownMenu } from 'radix-ui';
import type { ReactNode } from 'react';

import { copyToClipboard } from '../../lib/clipboard';
import { errorMessage } from '../../lib/errors';
import { formatCount } from '../../lib/format';
import { confirm } from '../../state/dialogs';
import { loadChildren, pathKey, toggleNode, useExplorer } from '../../state/explorer';
import {
  defaultShellScript,
  describeObject,
  dropCommand,
  dropMongoObject,
  mongoObjectOf,
  opensCollection,
  type MongoObject,
} from '../../state/mongo/explorer';
import {
  clearCollection,
  openDuplicateCollection,
  openRenameCollection,
} from '../../state/mongo/collection-actions';
import { openCreateCollection, openCreateView } from '../../state/mongo/create-dialogs';
import { mongoObjectsPathFor } from '../../state/objects-model';
import { shortcutLabel } from '../../state/keybindings';
import { showObjects, useObjectsView } from '../../state/objects-view';
import { openServerTools } from '../../state/server-tools/panels';
import { openTransferFrom } from '../../state/transfer-db/api';
import { BackupMenuItems } from '../backup/BackupDialogs';
import { MenuItem } from '../MenuItem';
import { CompareItems } from '../ObjectMenu';
import { Row } from '../Sidebar';
import { Icon } from '../ui';
import { CollectionNameDialog } from './CollectionNameDialog';
import { MongoCreateDialogs } from './CreateDialogs';
import { openIntelliShell, openMongoCollection, openMongoSql, openMongoTool } from './open';

/**
 * A MongoDB connection's object tree (spec §5): databases, then collections, views, time series
 * collections, GridFS buckets, users and roles, with each collection's indexes. Double-click (or
 * Enter) opens a collection or view in the collection view, a bucket in the GridFS browser and a
 * user or role in the users and roles editor; the menu opens a console and the tool panels
 * (aggregation, indexes, schema, options, change streams), creates collections and views,
 * refreshes, and drops objects after showing the exact command.
 */

type MongoIconName = 'collection' | 'view' | 'time-series' | 'bucket' | 'index' | 'user' | 'role';

function MongoIcon({ name }: { readonly name: MongoIconName }) {
  const paths: Record<MongoIconName, ReactNode> = {
    collection: (
      <>
        <rect x="3" y="2.5" width="10" height="3" rx="0.8" stroke="currentColor" fill="none" />
        <rect x="3" y="6.5" width="10" height="3" rx="0.8" stroke="currentColor" fill="none" />
        <rect x="3" y="10.5" width="10" height="3" rx="0.8" stroke="currentColor" fill="none" />
      </>
    ),
    view: (
      <>
        <path
          d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"
          stroke="currentColor"
          fill="none"
        />
        <circle cx="8" cy="8" r="2" stroke="currentColor" fill="none" />
      </>
    ),
    'time-series': (
      <path
        d="M2 12.5l3.5-4 3 2.5L14 4M2 14h12"
        stroke="currentColor"
        fill="none"
        strokeWidth="1.2"
      />
    ),
    bucket: (
      <>
        <path d="M2.5 5.5h11v8h-11z" stroke="currentColor" fill="none" />
        <path d="M2 3h12v2.5H2z" stroke="currentColor" fill="none" />
      </>
    ),
    index: (
      <>
        <circle cx="5.5" cy="8" r="3" stroke="currentColor" fill="none" />
        <path d="M8.5 8H14M12 8v2.5" stroke="currentColor" fill="none" />
      </>
    ),
    user: (
      <>
        <circle cx="8" cy="5.5" r="2.5" stroke="currentColor" fill="none" />
        <path d="M3 14c.5-3 2.5-4.5 5-4.5s4.5 1.5 5 4.5" stroke="currentColor" fill="none" />
      </>
    ),
    role: (
      <path
        d="M8 1.8l5 2v4c0 3.2-2.2 5.4-5 6.4-2.8-1-5-3.2-5-6.4v-4z"
        stroke="currentColor"
        fill="none"
      />
    ),
  };
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4 shrink-0 text-muted"
    >
      {paths[name]}
    </svg>
  );
}

export function iconFor(node: BrowseNode, expanded = false) {
  switch (node.kind) {
    case 'database':
      return <Icon name="database" className="text-lilac" />;
    case 'collection':
      return <MongoIcon name="collection" />;
    case 'view':
      return <MongoIcon name="view" />;
    case 'time-series':
      return <MongoIcon name="time-series" />;
    case 'gridfs-bucket':
      return <MongoIcon name="bucket" />;
    case 'index':
      return <MongoIcon name="index" />;
    case 'user':
      return <MongoIcon name="user" />;
    case 'role':
      return <MongoIcon name="role" />;
    default:
      return <Icon name={expanded ? 'folder-open' : 'folder'} className="text-muted" />;
  }
}

/** A short figure beside a node: documents, files, or an index's keys. */
function detailOf(node: BrowseNode): string | undefined {
  const detail = node.detail ?? {};
  if (typeof detail['count'] === 'number') return formatCount(detail['count']);
  if (typeof detail['files'] === 'number') {
    return `${formatCount(detail['files'])} ${detail['files'] === 1 ? 'file' : 'files'}`;
  }
  if (node.kind === 'index' && typeof detail['keys'] === 'string') {
    try {
      return formatShellInline(fromEjson(detail['keys'], 'index keys'));
    } catch {
      return detail['keys'];
    }
  }
  return undefined;
}

export function MongoTree(props: {
  readonly profile: StoredProfile;
  readonly depth: number;
  readonly onError: (message: string) => void;
}) {
  return (
    <>
      <MongoChildren {...props} path={[]} />
      <MongoCreateDialogs profileId={props.profile.id} />
      <CollectionNameDialog profileId={props.profile.id} />
    </>
  );
}

/** Opens the tool panel a node stands for on double-click; undefined when it has none. */
function toolOpener(profileId: string, node: BrowseNode): (() => void) | undefined {
  const [db, folder, name] = node.path;
  if (db === undefined) return undefined;
  if (node.kind === 'gridfs-bucket' && name !== undefined) {
    return () => openMongoTool({ tool: 'gridfs', target: { profileId, db, bucket: name } });
  }
  if ((node.kind === 'user' || node.kind === 'role') && name !== undefined) {
    const tab = node.kind === 'user' ? 'users' : 'roles';
    return () => openMongoTool({ tool: 'users', target: { profileId, db, tab, select: name } });
  }
  if (node.kind === 'index' && folder !== undefined && name !== undefined) {
    return () => openMongoTool({ tool: 'indexes', target: { profileId, db, collection: name } });
  }
  return undefined;
}

const SEPARATOR = <DropdownMenu.Separator className="my-1 h-px bg-border" />;

/** IntelliShell on a database, its script run as soon as the shell is up. */
function runInShell(profileId: string, database: string, text: string): void {
  openIntelliShell({ profileId, database, text, run: true });
}

/**
 * The tool menu items of a node, in Studio 3T's order (ADR 0036): for a collection, its tools
 * (IntelliShell, SQL, the Aggregation Editor), then copying, renaming, duplicating, clearing,
 * then indexes, validation and views, then schema, changes and transfers, then statistics; for a
 * database, IntelliShell and SQL, then creating, then users and roles, then the server's tools.
 */
function ToolItems(props: { readonly profile: StoredProfile; readonly node: BrowseNode }) {
  const { profile, node } = props;
  const profileId = profile.id;
  const readOnly = profile.presentation.readOnly;
  const [db, folder, name, sub] = node.path;
  if (db === undefined) return null;
  const object = mongoObjectOf(node);
  if (
    object &&
    (object.kind === 'collection' || object.kind === 'view' || object.kind === 'time-series')
  ) {
    const target = { profileId, db, collection: object.name };
    const writable = !readOnly && object.kind !== 'view';
    return (
      <>
        <MenuItem
          icon="shell"
          shortcut={shortcutLabel('mongo.openIntelliShell')}
          onSelect={() =>
            openIntelliShell({ profileId, database: db, text: defaultShellScript(object.name) })
          }
        >
          Open IntelliShell
        </MenuItem>
        <MenuItem
          icon="query"
          shortcut={shortcutLabel('mongo.openSql')}
          onSelect={() => openMongoSql({ profileId, db, collection: object.name })}
        >
          Open SQL
        </MenuItem>
        <MenuItem
          icon="filter"
          shortcut={shortcutLabel('mongo.openAggregation')}
          onSelect={() => openMongoTool({ tool: 'aggregation', target })}
        >
          Open Aggregation Editor
        </MenuItem>
        {SEPARATOR}
        <MenuItem icon="copy" onSelect={() => copyToClipboard(object.name)}>
          Copy Name
        </MenuItem>
        {writable && (
          <>
            <MenuItem icon="edit" onSelect={() => openRenameCollection(profileId, db, object.name)}>
              Rename Collection…
            </MenuItem>
            {object.kind === 'collection' && (
              <MenuItem
                icon="copy"
                onSelect={() => openDuplicateCollection(profileId, db, object.name)}
              >
                Duplicate Collection…
              </MenuItem>
            )}
            <MenuItem
              icon="discard"
              danger
              onSelect={() => void clearCollection(profileId, db, object.name)}
            >
              Clear Collection…
            </MenuItem>
          </>
        )}
        {SEPARATOR}
        {object.kind !== 'view' && (
          <MenuItem icon="key" onSelect={() => openMongoTool({ tool: 'indexes', target })}>
            Manage Indexes
          </MenuItem>
        )}
        <MenuItem icon="design" onSelect={() => openMongoTool({ tool: 'options', target })}>
          {object.kind === 'view' ? 'View Options' : 'Edit Validator and Options…'}
        </MenuItem>
        {!readOnly && (
          <MenuItem icon="plus" onSelect={() => openCreateView(profileId, db, object.name)}>
            Add View Here…
          </MenuItem>
        )}
        {SEPARATOR}
        <MenuItem
          icon="chart"
          onSelect={() =>
            openMongoTool({ tool: 'schema', target: { ...target, kind: object.kind } })
          }
        >
          Analyze Schema…
        </MenuItem>
        {object.kind !== 'view' && (
          <MenuItem
            icon="pulse"
            onSelect={() =>
              openMongoTool({
                tool: 'changes',
                target: {
                  profileId,
                  scope: { kind: 'collection', ns: { db, collection: object.name } },
                },
              })
            }
          >
            Watch Changes
          </MenuItem>
        )}
        <MenuItem
          icon="transfer"
          onSelect={() => openTransferFrom(profile, { database: db, objects: [object.name] })}
        >
          Transfer Data To…
        </MenuItem>
        {SEPARATOR}
        <MenuItem
          icon="gauge"
          onSelect={() => runInShell(profileId, db, `${collectionReference(object.name)}.stats()`)}
        >
          Collection Statistics
        </MenuItem>
        {object.kind !== 'view' && (
          <MenuItem
            icon="wrench"
            onSelect={() =>
              openServerTools(profile, {
                tab: 'maintenance',
                focus: { container: db, name: object.name },
              })
            }
          >
            Maintenance…
          </MenuItem>
        )}
      </>
    );
  }
  if (node.kind === 'database') {
    return (
      <>
        <MenuItem
          icon="shell"
          shortcut={shortcutLabel('mongo.openIntelliShell')}
          onSelect={() => openIntelliShell({ profileId, database: db })}
        >
          Open IntelliShell
        </MenuItem>
        <MenuItem
          icon="query"
          shortcut={shortcutLabel('mongo.openSql')}
          onSelect={() => openMongoSql({ profileId, db })}
        >
          Open SQL
        </MenuItem>
        {SEPARATOR}
        <MenuItem icon="copy" onSelect={() => copyToClipboard(db)}>
          Copy Name
        </MenuItem>
        {!readOnly && (
          <>
            <MenuItem icon="table-new" onSelect={() => openCreateCollection(profileId, db)}>
              Add Collection…
            </MenuItem>
            <MenuItem icon="plus" onSelect={() => openCreateView(profileId, db)}>
              Add View…
            </MenuItem>
          </>
        )}
        <MenuItem icon="transfer" onSelect={() => openTransferFrom(profile, { database: db })}>
          Transfer Data To…
        </MenuItem>
        <BackupMenuItems profile={profile} location={{ database: db }} />
        {SEPARATOR}
        <MenuItem
          icon="users"
          onSelect={() => openMongoTool({ tool: 'users', target: { profileId, db, tab: 'users' } })}
        >
          Manage Users
        </MenuItem>
        <MenuItem
          icon="key"
          onSelect={() => openMongoTool({ tool: 'users', target: { profileId, db, tab: 'roles' } })}
        >
          Manage Roles
        </MenuItem>
        {SEPARATOR}
        <MenuItem icon="gauge" onSelect={() => runInShell(profileId, db, 'db.stats()')}>
          DB Statistics
        </MenuItem>
        <MenuItem
          icon="history"
          onSelect={() => openServerTools(profile, { tab: 'topQueries', focus: { container: db } })}
        >
          Query Profiler
        </MenuItem>
        <MenuItem icon="pulse" onSelect={() => openServerTools(profile, { tab: 'sessions' })}>
          Current Operations
        </MenuItem>
        <MenuItem icon="server" onSelect={() => openServerTools(profile, { tab: 'monitor' })}>
          Server Status
        </MenuItem>
        <MenuItem icon="server" onSelect={() => runInShell(profileId, db, 'db.serverBuildInfo()')}>
          Server Build Info
        </MenuItem>
        {SEPARATOR}
        <MenuItem
          icon="pulse"
          onSelect={() =>
            openMongoTool({
              tool: 'changes',
              target: { profileId, scope: { kind: 'database', db } },
            })
          }
        >
          Watch Changes
        </MenuItem>
        <MenuItem
          icon="pulse"
          onSelect={() =>
            openMongoTool({ tool: 'changes', target: { profileId, scope: { kind: 'cluster' } } })
          }
        >
          Watch the Whole Deployment
        </MenuItem>
      </>
    );
  }
  if (node.kind !== 'folder') return null;
  if (sub === 'indexes' && name !== undefined) {
    return (
      <MenuItem
        icon="key"
        onSelect={() =>
          openMongoTool({ tool: 'indexes', target: { profileId, db, collection: name } })
        }
      >
        Manage Indexes
      </MenuItem>
    );
  }
  switch (folder) {
    case 'users':
    case 'roles':
      return (
        <MenuItem
          icon="users"
          onSelect={() => openMongoTool({ tool: 'users', target: { profileId, db, tab: folder } })}
        >
          {folder === 'users' ? 'Manage Users' : 'Manage Roles'}
        </MenuItem>
      );
    case 'collections':
      return (
        <>
          <MenuItem
            icon="shell"
            shortcut={shortcutLabel('mongo.openIntelliShell')}
            onSelect={() => openIntelliShell({ profileId, database: db })}
          >
            Open IntelliShell
          </MenuItem>
          {!readOnly && (
            <MenuItem icon="table-new" onSelect={() => openCreateCollection(profileId, db)}>
              Add Collection…
            </MenuItem>
          )}
        </>
      );
    case 'time-series':
      return readOnly ? null : (
        <MenuItem
          icon="table-new"
          onSelect={() => openCreateCollection(profileId, db, 'timeseries')}
        >
          Add Time Series Collection…
        </MenuItem>
      );
    case 'views':
      return readOnly ? null : (
        <MenuItem icon="plus" onSelect={() => openCreateView(profileId, db)}>
          Add View…
        </MenuItem>
      );
    default:
      return null;
  }
}

function MongoChildren(props: {
  readonly profile: StoredProfile;
  readonly path: readonly string[];
  readonly depth: number;
  readonly onError: (message: string) => void;
}) {
  const state = useExplorer((s) => s.children[props.profile.id]?.[pathKey(props.path)]);
  const indent = { paddingLeft: 12 + props.depth * 14 };
  if (!state || (state.loading && !state.nodes)) {
    return (
      <p className="py-1 text-xs text-muted" style={indent}>
        Loading…
      </p>
    );
  }
  if (state.error) {
    return (
      <p className="py-1 text-xs text-danger" style={indent}>
        {state.error}
      </p>
    );
  }
  if (state.nodes?.length === 0) {
    return (
      <p className="py-1 text-xs text-muted" style={indent}>
        Empty
      </p>
    );
  }
  return (
    <>
      {state.nodes?.map((node) => (
        <MongoNode
          key={pathKey(node.path)}
          node={node}
          profile={props.profile}
          depth={props.depth}
          onError={props.onError}
        />
      ))}
    </>
  );
}

/** What a MongoDB node opens on a double-click (or a click, for a collection): its documents or its tool panel. */
export function mongoNodeOpener(
  profile: StoredProfile,
  node: BrowseNode,
): (() => void) | undefined {
  const object = mongoObjectOf(node);
  if (
    opensCollection(node) &&
    object !== undefined &&
    'name' in object &&
    object.kind !== 'index'
  ) {
    return () =>
      openMongoCollection({
        profileId: profile.id,
        db: object.db,
        collection: object.name,
        kind: object.kind as 'collection' | 'view' | 'time-series',
      });
  }
  return toolOpener(profile.id, node);
}

/** Whether a node opens its documents (a collection, a view, a time series collection). */
export function opensDocuments(node: BrowseNode): boolean {
  const object = mongoObjectOf(node);
  return (
    opensCollection(node) && object !== undefined && 'name' in object && object.kind !== 'index'
  );
}

/** Whether a node has a menu at all. */
export function hasMongoMenu(profile: StoredProfile, node: BrowseNode): boolean {
  const object = mongoObjectOf(node);
  const command = object && !profile.presentation.readOnly ? dropCommand(object) : undefined;
  return (
    opensDocuments(node) ||
    node.kind === 'database' ||
    node.hasChildren ||
    command !== undefined ||
    toolOpener(profile.id, node) !== undefined
  );
}

/**
 * A MongoDB node's menu, in the tree and in the Objects view: open (a collection tab, files, the
 * index manager, users and roles), the tools in Studio 3T's order, compare, refresh, and drop
 * after showing the exact command.
 */
export function MongoNodeMenu(props: {
  readonly node: BrowseNode;
  readonly profile: StoredProfile;
  readonly onError: (message: string) => void;
}) {
  const { node, profile } = props;
  const object = mongoObjectOf(node);
  const opens = opensDocuments(node);
  const readOnly = profile.presentation.readOnly;
  const command = object && !readOnly ? dropCommand(object) : undefined;
  const database = node.path[0];
  const tool = toolOpener(profile.id, node);
  const open = mongoNodeOpener(profile, node) ?? (() => undefined);
  const drop = async (target: MongoObject, text: string): Promise<void> => {
    const ok = await confirm({
      title: `Drop ${describeObject(target)}?`,
      message:
        target.kind === 'database'
          ? 'The database and everything in it are deleted. This runs:'
          : 'This cannot be undone. This runs:',
      detail: text,
      confirmLabel: 'Drop',
      danger: true,
    });
    if (!ok) return;
    try {
      await dropMongoObject(profile.id, target);
    } catch (error) {
      props.onError(`${profile.name}: ${errorMessage(error)}`);
    }
  };
  return (
    <>
      {opens && (
        <MenuItem icon="table" onSelect={open} shortcut="↵">
          Open Collection Tab
        </MenuItem>
      )}
      {tool && (
        <MenuItem icon="open" onSelect={tool}>
          {node.kind === 'gridfs-bucket'
            ? 'Open GridFS View'
            : node.kind === 'index'
              ? 'Manage Indexes'
              : 'Open in Users and Roles'}
        </MenuItem>
      )}
      <ToolItems profile={profile} node={node} />
      {node.kind === 'database' && database !== undefined && (
        <CompareItems source={{ profileId: profile.id, database }} />
      )}
      {node.hasChildren && (
        <>
          {SEPARATOR}
          <MenuItem icon="refresh" onSelect={() => void loadChildren(profile.id, node.path)}>
            Refresh
          </MenuItem>
        </>
      )}
      {object && command && (
        <>
          {SEPARATOR}
          <MenuItem icon="trash" danger onSelect={() => void drop(object, command)}>
            {object.kind === 'database'
              ? 'Drop Database…'
              : object.kind === 'index'
                ? 'Drop Index…'
                : object.kind === 'view'
                  ? 'Drop View…'
                  : object.kind === 'user'
                    ? 'Drop User…'
                    : object.kind === 'role'
                      ? 'Drop Role…'
                      : 'Drop Collection…'}
          </MenuItem>
        </>
      )}
    </>
  );
}

function MongoNode(props: {
  readonly node: BrowseNode;
  readonly profile: StoredProfile;
  readonly depth: number;
  readonly onError: (message: string) => void;
}) {
  const { node, profile } = props;
  const expanded = useExplorer((s) => s.expanded[profile.id]?.[pathKey(node.path)] === true);
  const opens = opensDocuments(node);
  const tool = toolOpener(profile.id, node);
  const open = mongoNodeOpener(profile, node);
  const detail = detailOf(node);
  const listsObjects = mongoObjectsPathFor(node) !== undefined;
  const shown = useObjectsView(
    (s) =>
      s.location?.profileId === profile.id && pathKey(s.location.source) === pathKey(node.path),
  );

  return (
    <div
      role="treeitem"
      aria-expanded={node.hasChildren ? expanded : undefined}
      aria-selected={shown}
    >
      <Row
        depth={props.depth}
        expandable={node.hasChildren}
        expanded={expanded}
        onToggle={() => toggleNode(profile.id, node)}
        // A click opens a collection's documents (the chevron expands it), and shows a database's
        // or a folder's objects in the Objects view as it expands.
        clickToggles={!opens}
        onSelect={
          opens ? open : listsObjects ? () => showObjects(profile.id, node, 'mongodb') : undefined
        }
        onActivate={opens ? undefined : tool}
        selected={shown}
        title={opens ? 'Click to open the documents' : tool ? 'Double-click to open' : undefined}
        label={
          <span className="flex min-w-0 items-center gap-1.5" data-mongo-kind={node.kind}>
            {iconFor(node, expanded)}
            <span className="truncate">{node.name}</span>
            {detail !== undefined && (
              <span className="ml-auto max-w-[45%] shrink-0 truncate pl-1 font-mono text-[10px] text-muted">
                {detail}
              </span>
            )}
          </span>
        }
        menu={
          hasMongoMenu(profile, node) ? (
            <MongoNodeMenu node={node} profile={profile} onError={props.onError} />
          ) : undefined
        }
      />
      {expanded && node.hasChildren && (
        <div role="group">
          <MongoChildren
            profile={profile}
            path={node.path}
            depth={props.depth + 1}
            onError={props.onError}
          />
        </div>
      )}
    </div>
  );
}
