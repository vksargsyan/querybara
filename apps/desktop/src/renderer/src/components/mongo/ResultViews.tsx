import {
  BSON_TYPES,
  EJSON,
  VALUE_EDIT_LABELS,
  VALUE_EDIT_TYPES,
  bsonTypeOf,
  containerSummary,
  formatShell,
  formatShellInline,
  isBsonDocument,
  parseValueEdit,
  valueAtPath,
  valueEditText,
  valueEditType,
  type BsonTypeName,
  type BsonValue,
  type DocumentPath,
  type ValueEditType,
} from '@querybara/mongo-tools';
import { DropdownMenu } from 'radix-ui';
import {
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type UIEvent,
} from 'react';

import { errorMessage } from '../../lib/errors';

import { copyToClipboard } from '../../lib/clipboard';
import { formatCount } from '../../lib/format';
import {
  crumbsOf,
  drillInto,
  nodeKey,
  tableOf,
  useResults,
  type DocumentResults,
} from '../../state/mongo/results';
import { MenuItem } from '../MenuItem';
import { PointerAnchor } from '../PointerAnchor';
import { Button, Icon, cx } from '../ui';

/**
 * The three views of a MongoDB result (spec §9): tree, table and JSON. The collection view
 * passes document actions (edit, clone, delete, insert, and values edited in place);
 * IntelliShell shows results read-only. A right-click on a document opens Studio 3T's document
 * menu (ADR 0036): edit, clone, insert, remove, and copy as mongosh or Extended JSON; on a value
 * it adds Edit Value, Remove Field, Copy Value and Copy Field Path. A double-click on a value
 * edits it in place, typed (Enter saves, Escape cancels). Scrolling near the end fetches the
 * next page.
 */

export interface DocumentActions {
  readonly edit?: (index: number) => void;
  readonly clone?: (index: number) => void;
  readonly remove?: (index: number) => void;
  readonly insert?: () => void;
  /** Saves one value of a loaded document in place; true when it was saved. */
  readonly setValue?: (
    index: number,
    path: DocumentPath,
    value: BsonValue | undefined,
  ) => Promise<boolean>;
  /** Removes one field (or array element) of a loaded document. */
  readonly removeField?: (index: number, path: DocumentPath) => void;
}

/** The value a right-click landed on: its path in the document, and how to edit it in place. */
interface FieldAt {
  readonly path: DocumentPath;
  readonly edit?: () => void;
}

/** The document menu at the pointer: where it opened, on which document, and which value. */
interface DocumentMenuAt {
  readonly x: number;
  readonly y: number;
  readonly index: number;
  readonly field?: FieldAt;
}

/** A field path as mongosh writes it in a query: `items.0.qty`. */
function fieldPath(path: DocumentPath): string {
  return path.map(String).join('.');
}

/** A right-click handler for a document's row (or one of its values), and the menu it opens. */
function useDocumentMenu(results: DocumentResults, actions: DocumentActions | undefined) {
  const [at, setAt] = useState<DocumentMenuAt | undefined>();
  const open = (index: number, field?: FieldAt) => (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setAt({ x: event.clientX, y: event.clientY, index, ...(field ? { field } : {}) });
  };
  const copy = (style: 'shell' | 'ejson'): void => {
    const value = at === undefined ? undefined : results.values()[at.index];
    if (value === undefined) return;
    copyToClipboard(
      style === 'shell'
        ? formatShell(value)
        : EJSON.stringify(value, undefined, 2, { relaxed: true }),
    );
  };
  const copyValue = (): void => {
    const root = at === undefined ? undefined : results.values()[at.index];
    const value = root === undefined || !at?.field ? undefined : valueAtPath(root, at.field.path);
    if (value === undefined) return;
    copyToClipboard(typeof value === 'string' ? value : formatShell(value));
  };
  const field = at?.field;
  const menu = at && (
    <DropdownMenu.Root open onOpenChange={(next) => !next && setAt(undefined)}>
      <DropdownMenu.Trigger asChild>
        <PointerAnchor x={at.x} y={at.y} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          aria-label="Document"
          className="z-50 min-w-52 rounded border border-border bg-raised p-1 text-[13px] shadow-widget"
        >
          {field && (
            <>
              {field.edit && (
                <MenuItem icon="edit" onSelect={field.edit}>
                  Edit Value
                </MenuItem>
              )}
              {actions?.removeField && field.path[0] !== '_id' && (
                <MenuItem
                  icon="trash"
                  danger
                  onSelect={() => actions.removeField!(at.index, field.path)}
                >
                  Remove Field…
                </MenuItem>
              )}
              <MenuItem icon="copy" onSelect={copyValue}>
                Copy Value
              </MenuItem>
              <MenuItem icon="copy" onSelect={() => copyToClipboard(fieldPath(field.path))}>
                Copy Field Path
              </MenuItem>
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
            </>
          )}
          {actions?.edit && (
            <MenuItem icon="edit" onSelect={() => actions.edit!(at.index)}>
              Edit Document…
            </MenuItem>
          )}
          {actions?.clone && (
            <MenuItem icon="copy" onSelect={() => actions.clone!(at.index)}>
              Clone Document…
            </MenuItem>
          )}
          {actions?.insert && (
            <MenuItem icon="plus" onSelect={() => actions.insert!()}>
              Insert Document…
            </MenuItem>
          )}
          {actions?.remove && (
            <MenuItem icon="trash" danger onSelect={() => actions.remove!(at.index)}>
              Remove Document…
            </MenuItem>
          )}
          {actions && <DropdownMenu.Separator className="my-1 h-px bg-border" />}
          <MenuItem icon="copy" onSelect={() => copy('shell')}>
            Copy Document
          </MenuItem>
          <MenuItem icon="copy" onSelect={() => copy('ejson')}>
            Copy as Extended JSON
          </MenuItem>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
  return { open, menu };
}

const TYPE_CLASSES: Partial<Record<BsonTypeName, string>> = {
  objectId: 'text-warning',
  string: 'text-success',
  int: 'text-accent',
  long: 'text-accent',
  double: 'text-accent',
  decimal: 'text-accent',
  date: 'text-env-staging',
  bool: 'text-env-test',
  null: 'text-muted',
};

/** The BSON type of a value as a small badge ("ObjectId", "Int32", "Date"...). */
export function TypeBadge({ type }: { readonly type: BsonTypeName | 'missing' }) {
  const label = type === 'missing' ? 'missing' : BSON_TYPES[type].label;
  return (
    <span
      className="rounded border border-border bg-panel-2 px-1 py-px text-[10px] leading-none text-muted"
      data-bson-type={type}
    >
      {label}
    </span>
  );
}

/** A value's one-line text: containers summarised, strings quoted as the shell shows them. */
function valueText(value: BsonValue): string {
  return containerSummary(value) ?? formatShellInline(value, { maxStringLength: 300 });
}

/**
 * A value edited in place: its text in the chosen type, read back as that type on Enter
 * (Escape, or leaving the editor, cancels). A value that does not fit the type says why.
 */
function ValueEditor(props: {
  readonly value: BsonValue | undefined;
  readonly label: string;
  readonly onSave: (value: BsonValue) => Promise<boolean>;
  readonly onClose: () => void;
}) {
  const initialType = valueEditType(
    props.value === undefined ? 'missing' : bsonTypeOf(props.value),
  );
  const [type, setType] = useState<ValueEditType>(initialType);
  const [text, setText] = useState(() => valueEditText(props.value, initialType));
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  // The text as the type shows it, so a type change replaces only text nobody typed.
  const shown = useRef(text);
  const save = async (): Promise<void> => {
    let value: BsonValue;
    try {
      value = parseValueEdit(text, type);
    } catch (problem) {
      setError(errorMessage(problem));
      return;
    }
    setSaving(true);
    await props.onSave(value);
    props.onClose();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      if (!saving) void save();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      props.onClose();
    }
  };
  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (saving) return;
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) props.onClose();
  };
  return (
    <div
      className="flex min-w-56 items-center gap-1"
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      onDoubleClick={(event) => event.stopPropagation()}
      data-testid="mongo-value-editor"
    >
      <input
        autoFocus
        aria-label={`Value of ${props.label}`}
        aria-invalid={error !== undefined}
        title={error ?? 'Enter saves · Escape cancels'}
        disabled={saving || type === 'null'}
        value={type === 'null' ? '' : text}
        onChange={(event) => {
          setText(event.target.value);
          setError(undefined);
        }}
        className={cx(
          'min-w-0 flex-1 rounded-sm border bg-deep px-1 py-px font-mono text-xs text-fg outline-none',
          error ? 'border-danger' : 'border-focus',
        )}
      />
      <select
        aria-label={`Type of ${props.label}`}
        value={type}
        disabled={saving}
        onChange={(event) => {
          const next = event.target.value as ValueEditType;
          if (text === shown.current) {
            const fresh = valueEditText(props.value, next);
            shown.current = fresh;
            setText(fresh);
          }
          setType(next);
          setError(undefined);
        }}
        className="rounded-sm border border-border bg-deep px-0.5 py-px text-[11px] text-fg"
      >
        {VALUE_EDIT_TYPES.map((option) => (
          <option key={option} value={option}>
            {VALUE_EDIT_LABELS[option]}
          </option>
        ))}
      </select>
      {error !== undefined && (
        <span role="alert" className="max-w-64 truncate text-[11px] text-danger" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}

function onScrollEnd(results: DocumentResults) {
  return (event: UIEvent<HTMLElement>): void => {
    const element = event.currentTarget;
    if (element.scrollTop + element.clientHeight >= element.scrollHeight - 200) {
      results.onVisibleEnd();
    }
  };
}

function LoadMore({ results }: { readonly results: DocumentResults }) {
  const loading = useResults(results, (s) => s.loading);
  const hasMore = useResults(results, (s) => s.hasMore);
  const count = useResults(results, (s) => s.documents.length);
  const error = useResults(results, (s) => s.error);
  if (error) {
    return (
      <p role="alert" className="px-3 py-2 text-xs text-danger" data-testid="mongo-results-error">
        {error}
      </p>
    );
  }
  if (loading) return <p className="px-3 py-2 text-xs text-muted">Loading…</p>;
  if (count === 0) return <p className="px-3 py-2 text-xs text-muted">No documents.</p>;
  if (!hasMore) return null;
  return (
    <div className="px-3 py-2">
      <Button size="sm" variant="ghost" onClick={() => results.onVisibleEnd()}>
        Fetch more
      </Button>
    </div>
  );
}

export function ResultViews(props: {
  readonly results: DocumentResults;
  readonly actions?: DocumentActions;
}) {
  const mode = useResults(props.results, (s) => s.mode);
  if (mode === 'table') return <TableResults {...props} />;
  if (mode === 'json') return <JsonResults results={props.results} />;
  return <TreeResults {...props} />;
}

// ---------------------------------------------------------------------------------------------
// Tree

function TreeResults(props: {
  readonly results: DocumentResults;
  readonly actions?: DocumentActions;
}) {
  const { results } = props;
  const version = useResults(results, (s) => s.version);
  const expanded = useResults(results, (s) => s.expanded);
  const values = useMemo(
    () => results.values(),
    // Parsed again only when the documents change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [results, version],
  );
  // A page's documents are numbered on from the pages before it.
  const offset = useResults(results, (s) => s.offset);
  const documentMenu = useDocumentMenu(results, props.actions);
  // The value being edited in place, as its node key.
  const [editing, setEditing] = useState<string | undefined>();
  return (
    <div
      className="h-full overflow-auto font-mono text-xs select-text"
      data-testid="mongo-tree"
      role="tree"
      aria-label="Documents"
      onScroll={onScrollEnd(results)}
    >
      {values.map((value, index) => {
        const key = nodeKey(index, []);
        const open = expanded[key] === true;
        const id = isBsonDocument(value) ? value['_id'] : undefined;
        return (
          <div
            key={index}
            role="treeitem"
            aria-expanded={open}
            aria-selected={false}
            data-document={index}
            onContextMenu={documentMenu.open(index)}
          >
            <div className="group flex items-center gap-1.5 border-b border-border/60 px-2 py-1 hover:bg-hover">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                onClick={() => results.toggleNode(key)}
                aria-label={`Document ${offset + index + 1}`}
              >
                <Icon
                  name={open ? 'chevron-down' : 'chevron-right'}
                  className="h-3 w-3 text-muted"
                />
                <span className="text-muted">{offset + index + 1}</span>
                {id !== undefined && (
                  <span className="truncate">
                    <span className="text-muted">_id: </span>
                    {valueText(id)}
                  </span>
                )}
                <span className="truncate text-muted">{valueText(value)}</span>
              </button>
              <DocumentButtons index={index} number={offset + index + 1} actions={props.actions} />
            </div>
            {open && (
              <TreeChildren
                results={results}
                document={index}
                value={value}
                path={[]}
                depth={1}
                actions={props.actions}
                onMenu={documentMenu.open}
                editing={editing}
                onEdit={setEditing}
              />
            )}
          </div>
        );
      })}
      <LoadMore results={results} />
      {documentMenu.menu}
    </div>
  );
}

function DocumentButtons(props: {
  readonly index: number;
  /** The document's number as shown (on from the pages before). */
  readonly number: number;
  readonly actions: DocumentActions | undefined;
}) {
  const { actions, index, number } = props;
  if (!actions) return null;
  return (
    <span className="flex shrink-0 gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
      {actions.edit && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => actions.edit!(index)}
          aria-label={`Edit document ${number}`}
        >
          Edit
        </Button>
      )}
      {actions.clone && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => actions.clone!(index)}
          aria-label={`Clone document ${number}`}
        >
          Clone
        </Button>
      )}
      {actions.remove && (
        <Button
          size="sm"
          variant="ghost"
          className="text-danger"
          onClick={() => actions.remove!(index)}
          aria-label={`Delete document ${number}`}
        >
          Delete
        </Button>
      )}
    </span>
  );
}

function TreeChildren(props: {
  readonly results: DocumentResults;
  readonly document: number;
  readonly value: BsonValue;
  readonly path: DocumentPath;
  readonly depth: number;
  readonly actions: DocumentActions | undefined;
  readonly onMenu: (index: number, field?: FieldAt) => (event: MouseEvent) => void;
  readonly editing: string | undefined;
  readonly onEdit: (key: string | undefined) => void;
}) {
  const { results, document, value, path, depth, actions } = props;
  const expanded = useResults(results, (s) => s.expanded);
  const entries: [string | number, BsonValue][] = Array.isArray(value)
    ? value.map((item, i) => [i, item])
    : isBsonDocument(value)
      ? Object.keys(value).map((key) => [key, value[key]!])
      : [];
  return (
    <div role="group">
      {entries.map(([key, child]) => {
        const childPath = [...path, key];
        const container = Array.isArray(child) || isBsonDocument(child);
        const nodeId = nodeKey(document, childPath);
        const open = expanded[nodeId] === true;
        const setValue = actions?.setValue;
        // Containers are edited as a whole document; the _id never changes in place.
        const editable = setValue !== undefined && !container && childPath[0] !== '_id';
        const edit = editable ? () => props.onEdit(nodeId) : undefined;
        const editing = props.editing === nodeId;
        return (
          <div
            key={String(key)}
            role="treeitem"
            aria-expanded={container ? open : undefined}
            aria-selected={false}
          >
            <div
              className="flex items-center gap-1.5 px-2 py-0.5 hover:bg-hover"
              style={{ paddingLeft: 8 + depth * 16 }}
              data-field={String(key)}
              onContextMenu={props.onMenu(document, {
                path: childPath,
                ...(edit ? { edit } : {}),
              })}
              onDoubleClick={edit}
            >
              <span className="w-3">
                {container && (
                  <button
                    type="button"
                    aria-label={`Expand ${String(key)}`}
                    onClick={() => results.toggleNode(nodeId)}
                  >
                    <Icon
                      name={open ? 'chevron-down' : 'chevron-right'}
                      className="h-3 w-3 text-muted"
                    />
                  </button>
                )}
              </span>
              <span
                className={cx('shrink-0', typeof key === 'number' ? 'text-muted' : 'font-semibold')}
              >
                {typeof key === 'number' ? `[${key}]` : key}
              </span>
              {editing && setValue ? (
                <span className="min-w-0 flex-1">
                  <ValueEditor
                    value={child}
                    label={fieldPath(childPath)}
                    onSave={(next) => setValue(document, childPath, next)}
                    onClose={() => props.onEdit(undefined)}
                  />
                </span>
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate">
                    <span className={cx(TYPE_CLASSES[bsonTypeOf(child)])}>{valueText(child)}</span>
                  </span>
                  <TypeBadge type={bsonTypeOf(child)} />
                </>
              )}
            </div>
            {container && open && (
              <TreeChildren
                results={results}
                document={document}
                value={child}
                path={childPath}
                depth={depth + 1}
                actions={actions}
                onMenu={props.onMenu}
                editing={props.editing}
                onEdit={props.onEdit}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Table

function TableResults(props: {
  readonly results: DocumentResults;
  readonly actions?: DocumentActions;
}) {
  const { results } = props;
  const version = useResults(results, (s) => s.version);
  const drill = useResults(results, (s) => s.drill);
  // A page's documents are numbered on from the pages before it.
  const offset = useResults(results, (s) => s.offset);
  const flatten = useResults(results, (s) => s.flatten);
  const columnOrder = useResults(results, (s) => s.columnOrder);
  const view = useMemo(
    () => tableOf(results.values(), drill, flatten, columnOrder),
    // Rebuilt when the documents, the drill, the flattening or the column order change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [results, version, drill, flatten, columnOrder],
  );
  const crumbs = crumbsOf(drill);
  const actions = drill ? undefined : props.actions;
  // Values edit in place in a drilled table too: a sub-document's fields, an array's elements.
  const setValue = props.actions?.setValue;
  const documentMenu = useDocumentMenu(
    results,
    drill && props.actions?.removeField ? { removeField: props.actions.removeField } : actions,
  );
  // The cell being edited in place: its row and column.
  const [editing, setEditing] = useState<{ row: number; column: number } | undefined>();
  return (
    <div className="flex h-full flex-col" data-testid="mongo-table">
      <div className="flex items-center gap-2 border-b border-border bg-panel px-2 py-1 text-xs">
        <nav
          aria-label="Drill-down"
          className="flex min-w-0 flex-1 items-center gap-1"
          data-testid="mongo-breadcrumb"
        >
          {crumbs.map((crumb, i) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <span className="text-muted">›</span>}
              {i === crumbs.length - 1 ? (
                <span className="font-semibold" aria-current="location">
                  {crumb.label}
                </span>
              ) : (
                <button
                  type="button"
                  className="text-accent hover:underline"
                  onClick={() => results.setDrill(crumb.drill)}
                >
                  {crumb.label}
                </button>
              )}
            </span>
          ))}
        </nav>
        <label
          className="flex items-center gap-1 text-muted"
          title="Show sub-document fields as columns"
        >
          <input
            type="checkbox"
            checked={flatten}
            onChange={(event) => results.setFlatten(event.target.checked)}
          />
          Nested fields as columns
        </label>
        {view.truncatedColumns && <span className="text-warning">Some columns are not shown</span>}
      </div>
      <div
        className="min-h-0 flex-1 overflow-auto"
        onScroll={drill ? undefined : onScrollEnd(results)}
      >
        <table className="min-w-full border-collapse font-mono text-xs select-text" role="grid">
          <thead className="sticky top-0 z-10 bg-panel">
            <tr>
              <th className="border-r border-b border-border px-2 py-1 text-left text-muted">#</th>
              {view.columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className="border-r border-b border-border px-2 py-1 text-left font-semibold whitespace-nowrap"
                  data-column={column.key}
                >
                  <span className="mr-1.5">{column.key === '' ? 'value' : column.key}</span>
                  {column.types[0] && <TypeBadge type={column.types[0]} />}
                </th>
              ))}
              {actions && <th className="border-b border-border" aria-label="Actions" />}
            </tr>
          </thead>
          <tbody>
            {view.rows.map((row, r) => (
              <tr
                key={r}
                className="group hover:bg-hover"
                data-row={r}
                onContextMenu={documentMenu.open(row.document)}
              >
                <td className="border-r border-b border-border/60 px-2 py-0.5 text-muted">
                  {drill ? pathTail(row.path) : r + 1}
                </td>
                {row.cells.map((cell, c) => {
                  const path = [...row.path, ...view.columns[c]!.path];
                  const editable =
                    setValue !== undefined &&
                    cell.drill === undefined &&
                    path.length > 0 &&
                    path[0] !== '_id';
                  const edit = editable ? () => setEditing({ row: r, column: c }) : undefined;
                  const inPlace = editing?.row === r && editing.column === c && setValue;
                  return (
                    <td
                      key={c}
                      className="max-w-80 border-r border-b border-border/60 px-2 py-0.5 whitespace-nowrap"
                      data-bson-type={cell.type}
                      onContextMenu={documentMenu.open(row.document, {
                        path,
                        ...(edit ? { edit } : {}),
                      })}
                      onDoubleClick={edit}
                    >
                      {inPlace ? (
                        <ValueEditor
                          value={valueAtPath(results.values()[row.document]!, path)}
                          label={fieldPath(path)}
                          onSave={(next) => inPlace(row.document, path, next)}
                          onClose={() => setEditing(undefined)}
                        />
                      ) : cell.drill ? (
                        <button
                          type="button"
                          className="text-accent hover:underline"
                          title="Show as a table"
                          onClick={() => results.setDrill(drillInto(drill, row, cell))}
                        >
                          {cell.text}
                        </button>
                      ) : (
                        <span
                          className={cx(
                            'block truncate',
                            cell.type !== 'missing' && TYPE_CLASSES[cell.type],
                          )}
                        >
                          {cell.text}
                        </span>
                      )}
                    </td>
                  );
                })}
                {actions && (
                  <td className="border-b border-border/60 px-1">
                    <DocumentButtons
                      index={row.document}
                      number={offset + row.document + 1}
                      actions={actions}
                    />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {!drill && <LoadMore results={results} />}
      </div>
      {documentMenu.menu}
    </div>
  );
}

/** The last step of a row's path in a drilled table: "[2]" or the field name. */
function pathTail(path: DocumentPath): ReactNode {
  const last = path.at(-1);
  return last === undefined ? '' : typeof last === 'number' ? `[${last}]` : last;
}

// ---------------------------------------------------------------------------------------------
// JSON

function JsonResults({ results }: { readonly results: DocumentResults }) {
  const version = useResults(results, (s) => s.version);
  const style = useResults(results, (s) => s.jsonStyle);
  const count = useResults(results, (s) => s.documents.length);
  const text = useMemo(
    () => results.json(),
    // Printed again when the documents or the style change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [results, version, style],
  );
  return (
    <div className="flex h-full flex-col" data-testid="mongo-json">
      <div className="flex items-center gap-2 border-b border-border bg-panel px-2 py-1 text-xs text-muted">
        <span>
          {formatCount(count)} {count === 1 ? 'document' : 'documents'}
        </span>
        <div
          className="flex rounded border border-border"
          role="radiogroup"
          aria-label="JSON style"
        >
          {(['shell', 'ejson'] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={style === option}
              className={cx(
                'px-2 py-0.5',
                style === option ? 'bg-badge text-fg' : 'hover:bg-hover',
              )}
              onClick={() => results.setJsonStyle(option)}
            >
              {option === 'shell' ? 'mongosh' : 'Relaxed EJSON'}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => copyToClipboard(text)}>
          <Icon name="format" className="h-3 w-3" />
          Copy
        </Button>
      </div>
      <pre
        className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs select-text"
        data-testid="mongo-json-text"
        onScroll={onScrollEnd(results)}
      >
        {text}
      </pre>
      <LoadMore results={results} />
    </div>
  );
}
