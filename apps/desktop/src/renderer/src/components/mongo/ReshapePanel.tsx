import { RESHAPE_TYPES, type ReshapeAction, type ReshapeType } from '@querybara/mongo-tools';

import {
  RESHAPE_ACTION_LABELS,
  RESHAPE_KIND_ACTIONS,
  useReshape,
  type Reshape,
  type RuleRow,
} from '../../state/mongo/reshape';
import { useTheme } from '../theme';
import { Button, Icon, cx } from '../ui';
import { openMongoTool } from './open';
import { NoticeBanner, RulesBanners, SmallSelect } from './parts';
import { ResultViews } from './ResultViews';
import { ShellEditor } from './ShellEditor';

/**
 * Reschema and Data Masking (ADR 0038): a rule per field of the collection (read from a sample),
 * what the rules do to the first documents, the pipeline they make, and where it writes.
 */

const INPUT =
  'h-6 rounded border border-border bg-deep px-1.5 font-mono text-xs text-fg focus:border-focus focus:outline-none';

export function ReshapePanel({ panel }: { readonly panel: Reshape }) {
  const rules = useReshape(panel, (s) => s.rules);
  const onlyListed = useReshape(panel, (s) => s.onlyListed);
  const output = useReshape(panel, (s) => s.output);
  const outputMode = useReshape(panel, (s) => s.outputMode);
  const scanning = useReshape(panel, (s) => s.scanning);
  const running = useReshape(panel, (s) => s.running);
  const previewing = useReshape(panel, (s) => s.previewing);
  const writeRules = useReshape(panel, (s) => s.writeRules);
  const notice = useReshape(panel, (s) => s.notice);
  const theme = useTheme();
  const { kind, db, collection, profileId } = panel.target;
  const pipeline = panel.pipelineText();
  const mask = kind === 'mask';
  return (
    <div className="flex h-full flex-col" data-testid="mongo-reshape">
      <div
        className="flex flex-wrap items-center gap-1 border-b border-border bg-panel px-2 py-1"
        role="toolbar"
        aria-label={mask ? 'Data Masking' : 'Reschema'}
      >
        <span className="mr-2 text-xs font-semibold">{mask ? 'Data Masking' : 'Reschema'}</span>
        <span className="font-mono text-xs text-muted">
          {db}.{collection}
        </span>
        <span className="mx-1 h-4 w-px bg-border" />
        <Button size="sm" variant="ghost" disabled={scanning} onClick={() => void panel.scan()}>
          <Icon name="refresh" className="h-3.5 w-3.5" />
          {scanning ? 'Reading fields…' : 'Read fields again'}
        </Button>
        {!mask && (
          <Button size="sm" variant="ghost" onClick={() => panel.addComputed()}>
            <Icon name="plus" className="h-3.5 w-3.5" />
            Add computed field
          </Button>
        )}
        <label className="ml-2 flex items-center gap-1 text-xs text-muted">
          <input
            type="checkbox"
            checked={onlyListed}
            onChange={(event) => panel.setOnlyListed(event.target.checked)}
          />
          Only the fields listed
        </label>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            const text = panel.aggregationText();
            if (text !== undefined) {
              openMongoTool({ tool: 'aggregation', target: { profileId, db, collection, text } });
            }
          }}
        >
          <Icon name="filter" className="h-3.5 w-3.5" />
          Open in Aggregation Editor
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={previewing}
          onClick={() => void panel.preview()}
        >
          <Icon name="search" className="h-3.5 w-3.5" />
          Preview
        </Button>
      </div>
      <RulesBanners rules={writeRules} what="the result" />
      <NoticeBanner notice={notice} onDismiss={() => panel.dismissNotice()} />
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="min-h-0 overflow-auto border-r border-border">
          <table className="w-full border-collapse text-xs" aria-label="Field rules">
            <thead className="sticky top-0 z-10 bg-panel text-left text-muted">
              <tr>
                <th className="border-b border-border px-2 py-1 font-medium">Field</th>
                <th className="border-b border-border px-2 py-1 font-medium">Rule</th>
                <th className="border-b border-border px-2 py-1 font-medium">Into</th>
                <th className="border-b border-border px-2 py-1 font-medium">Settings</th>
                <th className="border-b border-border" aria-label="Remove" />
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <RuleEditor key={rule.id} panel={panel} rule={rule} />
              ))}
            </tbody>
          </table>
          {rules.length === 0 && !scanning && (
            <p className="px-2 py-3 text-xs text-muted">The sample has no fields.</p>
          )}
        </div>
        <div className="flex min-h-0 flex-col">
          <div className="grid min-h-0 flex-1 grid-rows-2">
            <section className="flex min-h-0 flex-col border-b border-border" aria-label="Before">
              <h3 className="border-b border-border bg-panel px-2 py-0.5 text-[11px] text-muted">
                Before (the first documents)
              </h3>
              <div className="min-h-0 flex-1">
                <ResultViews results={panel.before} />
              </div>
            </section>
            <section className="flex min-h-0 flex-col" aria-label="After">
              <h3 className="border-b border-border bg-panel px-2 py-0.5 text-[11px] text-muted">
                After
              </h3>
              <div className="min-h-0 flex-1">
                <ResultViews results={panel.after} />
              </div>
            </section>
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-1 border-t border-border bg-panel px-2 py-1.5">
        <div className="h-24 rounded border border-border">
          <ShellEditor
            value={'text' in pipeline ? pipeline.text : ''}
            onChange={() => undefined}
            readOnly
            wrap
            theme={theme}
            ariaLabel="The pipeline"
            testId="mongo-reshape-pipeline"
            className="h-full"
          />
        </div>
        {'error' in pipeline && (
          <p role="alert" className="text-xs text-danger" data-testid="mongo-reshape-issue">
            {pipeline.error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <label className="flex items-center gap-1" htmlFor={`reshape-output-${panel.id}`}>
            Write into
            <input
              id={`reshape-output-${panel.id}`}
              aria-label="Output collection"
              className={cx(INPUT, 'w-56')}
              value={output}
              onChange={(event) => panel.setOutput(event.target.value)}
            />
          </label>
          <SmallSelect
            aria-label="How to write"
            value={outputMode}
            onChange={(event) =>
              panel.setOutput(output, event.target.value === 'merge' ? 'merge' : 'replace')
            }
          >
            <option value="replace">replacing what it holds ($out)</option>
            <option value="merge">merging by _id ($merge)</option>
          </SmallSelect>
          <span className="flex-1" />
          <Button
            variant="primary"
            size="sm"
            disabled={running || 'error' in pipeline || writeRules.readOnlyProfile}
            onClick={() => void panel.run()}
          >
            <Icon name="play" className="h-3.5 w-3.5" />
            {running ? 'Running…' : 'Run'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function RuleEditor({ panel, rule }: { readonly panel: Reshape; readonly rule: RuleRow }) {
  const actions = RESHAPE_KIND_ACTIONS[panel.target.kind];
  const computed = rule.action === 'computed';
  const set = (patch: Parameters<Reshape['setRule']>[1]): void => panel.setRule(rule.id, patch);
  const label = computed ? rule.target || 'new field' : rule.field;
  return (
    <tr className="hover:bg-hover" data-rule={computed ? `computed:${rule.id}` : rule.field}>
      <td className="border-b border-border/60 px-2 py-0.5 font-mono">
        {computed ? <span className="text-muted">computed</span> : rule.field}
      </td>
      <td className="border-b border-border/60 px-2 py-0.5">
        {computed ? (
          'Computed'
        ) : (
          <SmallSelect
            aria-label={`Rule for ${label}`}
            value={rule.action}
            onChange={(event) => set({ action: event.target.value as ReshapeAction })}
          >
            {actions.map((action) => (
              <option key={action} value={action}>
                {RESHAPE_ACTION_LABELS[action]}
              </option>
            ))}
          </SmallSelect>
        )}
      </td>
      <td className="border-b border-border/60 px-2 py-0.5">
        {rule.action !== 'exclude' && (
          <input
            aria-label={`New path of ${label}`}
            className={cx(INPUT, 'w-40')}
            value={rule.target ?? ''}
            placeholder={computed ? 'field' : rule.field}
            onChange={(event) => set({ target: event.target.value })}
          />
        )}
      </td>
      <td className="border-b border-border/60 px-2 py-0.5">
        <RuleSettings rule={rule} label={label} set={set} />
      </td>
      <td className="border-b border-border/60 px-1">
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Remove the rule for ${label}`}
          title="Remove the rule: the field stays as it is"
          onClick={() => panel.removeRule(rule.id)}
        >
          <Icon name="close" className="h-3 w-3" />
        </Button>
      </td>
    </tr>
  );
}

function RuleSettings(props: {
  readonly rule: RuleRow;
  readonly label: string;
  readonly set: (patch: Parameters<Reshape['setRule']>[1]) => void;
}) {
  const { rule, label, set } = props;
  const number = (value: string): number | undefined =>
    value.trim() === '' || Number.isNaN(Number(value)) ? undefined : Number(value);
  switch (rule.action) {
    case 'convert':
      return (
        <SmallSelect
          aria-label={`Type of ${label}`}
          value={rule.type ?? ''}
          onChange={(event) => set({ type: event.target.value as ReshapeType })}
        >
          <option value="" disabled>
            Choose…
          </option>
          {RESHAPE_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </SmallSelect>
      );
    case 'mask':
      return (
        <span className="flex items-center gap-1 text-muted">
          show
          <input
            aria-label={`Characters shown at the start of ${label}`}
            className={cx(INPUT, 'w-10')}
            value={rule.keepStart ?? 0}
            onChange={(event) => set({ keepStart: number(event.target.value) ?? 0 })}
          />
          first,
          <input
            aria-label={`Characters shown at the end of ${label}`}
            className={cx(INPUT, 'w-10')}
            value={rule.keepEnd ?? 0}
            onChange={(event) => set({ keepEnd: number(event.target.value) ?? 0 })}
          />
          last, with
          <input
            aria-label={`Mask character of ${label}`}
            className={cx(INPUT, 'w-8')}
            value={rule.maskChar ?? '*'}
            onChange={(event) => set({ maskChar: event.target.value })}
          />
        </span>
      );
    case 'fixed':
    case 'computed':
      return (
        <input
          aria-label={rule.action === 'fixed' ? `Value for ${label}` : `Expression for ${label}`}
          className={cx(INPUT, 'w-64')}
          value={rule.value ?? ''}
          placeholder={
            rule.action === 'fixed' ? "'hidden'" : "{ $concat: ['$first', ' ', '$last'] }"
          }
          onChange={(event) => set({ value: event.target.value })}
        />
      );
    case 'random-number':
    case 'random-date':
      return (
        <span className="flex items-center gap-1 text-muted">
          ±
          <input
            aria-label={`Spread of ${label}`}
            className={cx(INPUT, 'w-14')}
            value={rule.spread ?? (rule.action === 'random-number' ? 10 : 30)}
            onChange={(event) => set({ spread: number(event.target.value) ?? 0 })}
          />
          {rule.action === 'random-number' ? '%' : 'days'}
        </span>
      );
    default:
      return null;
  }
}
