import type { ResultMode } from '../../state/mongo/results';
import { Icon } from '../ui';

/**
 * Studio 3T's view picker at the right of a result toolbar: Table View, Tree View or JSON View
 * (Ctrl+Alt+2, 1 and 3 in a collection tab).
 */

export const RESULT_VIEWS: readonly { readonly value: ResultMode; readonly label: string }[] = [
  { value: 'table', label: 'Table View' },
  { value: 'tree', label: 'Tree View' },
  { value: 'json', label: 'JSON View' },
];

export function ResultViewSelect(props: {
  readonly value: ResultMode;
  readonly onChange: (mode: ResultMode) => void;
  readonly testId?: string;
}) {
  const icon =
    props.value === 'table' ? 'view-grid' : props.value === 'tree' ? 'view-tree' : 'view-json';
  return (
    <label className="flex items-center gap-1 rounded-sm border border-border bg-panel-2 pl-1.5 text-xs">
      <Icon name={icon} className="h-3.5 w-3.5 text-muted" />
      <select
        aria-label="View"
        data-testid={props.testId}
        className="h-[20px] bg-transparent pr-1 text-xs text-fg focus:outline-none"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value as ResultMode)}
      >
        {RESULT_VIEWS.map((view) => (
          <option key={view.value} value={view.value}>
            {view.label}
          </option>
        ))}
      </select>
    </label>
  );
}
