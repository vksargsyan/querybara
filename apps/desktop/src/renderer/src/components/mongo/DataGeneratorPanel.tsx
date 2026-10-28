import { GENERATOR_KINDS, type GeneratorKind } from '@querybara/mongo-tools';

import {
  GENERATOR_KIND_LABELS,
  useDataGenerator,
  type DataGenerator,
  type GeneratorRow,
} from '../../state/mongo/generate';
import { Button, Icon, cx } from '../ui';
import { NoticeBanner, RulesBanners, SmallSelect } from './parts';
import { ResultViews } from './ResultViews';

/**
 * The Data Generator: a rule per field (read from a sample of the collection), the first
 * documents they make, and how many to insert with which seed.
 */

const INPUT =
  'h-6 rounded border border-border bg-deep px-1.5 font-mono text-xs text-fg focus:border-focus focus:outline-none';

export function DataGeneratorPanel({ panel }: { readonly panel: DataGenerator }) {
  const rules = useDataGenerator(panel, (s) => s.rules);
  const count = useDataGenerator(panel, (s) => s.count);
  const seed = useDataGenerator(panel, (s) => s.seed);
  const mode = useDataGenerator(panel, (s) => s.mode);
  const scanning = useDataGenerator(panel, (s) => s.scanning);
  const progress = useDataGenerator(panel, (s) => s.progress);
  const writeRules = useDataGenerator(panel, (s) => s.writeRules);
  const notice = useDataGenerator(panel, (s) => s.notice);
  const { db, collection } = panel.target;
  const countIssue = typeof panel.countOf() === 'string' ? panel.countOf() : undefined;
  return (
    <div className="flex h-full flex-col" data-testid="mongo-generate">
      <div
        className="flex flex-wrap items-center gap-1 border-b border-border bg-panel px-2 py-1"
        role="toolbar"
        aria-label="Data Generator"
      >
        <span className="mr-2 text-xs font-semibold">Data Generator</span>
        <span className="font-mono text-xs text-muted">
          {db}.{collection}
        </span>
        <span className="mx-1 h-4 w-px bg-border" />
        <Button size="sm" variant="ghost" disabled={scanning} onClick={() => void panel.scan()}>
          <Icon name="refresh" className="h-3.5 w-3.5" />
          {scanning ? 'Reading fields…' : 'Read fields again'}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => panel.addRule()}>
          <Icon name="plus" className="h-3.5 w-3.5" />
          Add field
        </Button>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => void panel.refreshPreview()}>
          <Icon name="search" className="h-3.5 w-3.5" />
          Preview
        </Button>
      </div>
      <RulesBanners rules={writeRules} what="the documents" />
      <NoticeBanner notice={notice} onDismiss={() => panel.dismissNotice()} />
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="min-h-0 overflow-auto border-r border-border">
          <table className="w-full border-collapse text-xs" aria-label="Field rules">
            <thead className="sticky top-0 z-10 bg-panel text-left text-muted">
              <tr>
                <th className="border-b border-border px-2 py-1 font-medium">Field</th>
                <th className="border-b border-border px-2 py-1 font-medium">Value</th>
                <th className="border-b border-border px-2 py-1 font-medium">Settings</th>
                <th className="border-b border-border px-2 py-1 font-medium">Missing</th>
                <th className="border-b border-border px-2 py-1 font-medium">Array</th>
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
            <p className="px-2 py-3 text-xs text-muted">Add a field to generate.</p>
          )}
        </div>
        <section className="flex min-h-0 flex-col" aria-label="Preview">
          <h3 className="border-b border-border bg-panel px-2 py-0.5 text-[11px] text-muted">
            The first documents
          </h3>
          <div className="min-h-0 flex-1">
            <ResultViews results={panel.preview} />
          </div>
        </section>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-border bg-panel px-2 py-1.5 text-xs">
        <label className="flex items-center gap-1" htmlFor={`generate-count-${panel.id}`}>
          Documents
          <input
            id={`generate-count-${panel.id}`}
            aria-label="Number of documents"
            inputMode="numeric"
            className={cx(INPUT, 'w-24')}
            value={count}
            aria-invalid={countIssue !== undefined}
            onChange={(event) => panel.setCount(event.target.value)}
          />
        </label>
        <label className="flex items-center gap-1" htmlFor={`generate-seed-${panel.id}`}>
          Seed
          <input
            id={`generate-seed-${panel.id}`}
            aria-label="Seed"
            inputMode="numeric"
            className={cx(INPUT, 'w-28')}
            value={seed}
            onChange={(event) => panel.setSeed(event.target.value)}
            onBlur={() => void panel.refreshPreview()}
          />
        </label>
        <Button size="sm" variant="ghost" onClick={() => panel.newSeed()} title="A new seed">
          <Icon name="refresh" className="h-3.5 w-3.5" />
        </Button>
        <SmallSelect
          aria-label="Existing documents"
          value={mode}
          onChange={(event) =>
            panel.setMode(event.target.value === 'replace' ? 'replace' : 'append')
          }
        >
          <option value="append">added to the collection</option>
          <option value="replace">replacing what it holds</option>
        </SmallSelect>
        {countIssue !== undefined && <span className="text-danger">{countIssue}</span>}
        <span className="flex-1" />
        {progress !== undefined && (
          <>
            <span className="text-muted" data-testid="mongo-generate-progress">
              {progress.done.toLocaleString()} of {progress.total.toLocaleString()}
            </span>
            <Button size="sm" variant="ghost" onClick={() => panel.cancel()}>
              Stop
            </Button>
          </>
        )}
        <Button
          variant="primary"
          size="sm"
          disabled={
            progress !== undefined ||
            rules.length === 0 ||
            countIssue !== undefined ||
            writeRules.readOnlyProfile
          }
          onClick={() => void panel.generate()}
        >
          <Icon name="play" className="h-3.5 w-3.5" />
          {progress !== undefined ? 'Generating…' : 'Generate'}
        </Button>
      </div>
    </div>
  );
}

function RuleEditor({
  panel,
  rule,
}: {
  readonly panel: DataGenerator;
  readonly rule: GeneratorRow;
}) {
  const set = (patch: Parameters<DataGenerator['setRule']>[1]): void => {
    panel.setRule(rule.id, patch);
  };
  const commit = (patch: Parameters<DataGenerator['setRule']>[1]): void => {
    set(patch);
    void panel.refreshPreview();
  };
  const label = rule.field || 'new field';
  const array =
    rule.arrayMax === undefined
      ? ''
      : rule.arrayMin === undefined || rule.arrayMin === rule.arrayMax
        ? String(rule.arrayMax)
        : `${rule.arrayMin}-${rule.arrayMax}`;
  return (
    <tr className="hover:bg-hover" data-rule={rule.field}>
      <td className="border-b border-border/60 px-2 py-0.5">
        <input
          aria-label={`Field ${label}`}
          className={cx(INPUT, 'w-36')}
          value={rule.field}
          placeholder="address.city"
          onChange={(event) => set({ field: event.target.value })}
          onBlur={() => void panel.refreshPreview()}
        />
      </td>
      <td className="border-b border-border/60 px-2 py-0.5">
        <SmallSelect
          aria-label={`Value of ${label}`}
          value={rule.kind}
          onChange={(event) => commit({ kind: event.target.value as GeneratorKind })}
        >
          {GENERATOR_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {GENERATOR_KIND_LABELS[kind]}
            </option>
          ))}
        </SmallSelect>
      </td>
      <td className="border-b border-border/60 px-2 py-0.5">
        <RuleSettings
          rule={rule}
          label={label}
          set={set}
          commit={() => void panel.refreshPreview()}
        />
      </td>
      <td className="border-b border-border/60 px-2 py-0.5">
        <span className="flex items-center gap-0.5 text-muted">
          <input
            aria-label={`Share of documents without ${label}`}
            className={cx(INPUT, 'w-10')}
            value={rule.missing ?? 0}
            onChange={(event) => set({ missing: numberIn(event.target.value) ?? 0 })}
            onBlur={() => void panel.refreshPreview()}
          />
          %
        </span>
      </td>
      <td className="border-b border-border/60 px-2 py-0.5">
        <input
          aria-label={`Array length of ${label}`}
          title="Empty for one value; n, or n-m, for an array of that many"
          className={cx(INPUT, 'w-14')}
          defaultValue={array}
          placeholder="one"
          onBlur={(event) => {
            commit(arrayRange(event.target.value));
          }}
        />
      </td>
      <td className="border-b border-border/60 px-1">
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Remove the rule for ${label}`}
          onClick={() => {
            panel.removeRule(rule.id);
            void panel.refreshPreview();
          }}
        >
          <Icon name="close" className="h-3 w-3" />
        </Button>
      </td>
    </tr>
  );
}

function numberIn(value: string): number | undefined {
  return value.trim() === '' || Number.isNaN(Number(value)) ? undefined : Number(value);
}

/** "3" or "1-4" as an array length; empty for one value. */
function arrayRange(text: string): {
  arrayMin: number | undefined;
  arrayMax: number | undefined;
} {
  const match = /^\s*(\d+)\s*(?:[-–]\s*(\d+))?\s*$/.exec(text);
  if (!match) return { arrayMin: undefined, arrayMax: undefined };
  const low = Number(match[1]);
  const high = match[2] === undefined ? low : Number(match[2]);
  return { arrayMin: Math.min(low, high), arrayMax: Math.max(low, high) };
}

function RuleSettings(props: {
  readonly rule: GeneratorRow;
  readonly label: string;
  readonly set: (patch: Parameters<DataGenerator['setRule']>[1]) => void;
  readonly commit: () => void;
}) {
  const { rule, label, set, commit } = props;
  const numberField = (
    key: 'min' | 'max' | 'decimals' | 'trueShare',
    name: string,
    width = 'w-16',
  ) => (
    <input
      aria-label={`${name} of ${label}`}
      className={cx(INPUT, width)}
      value={rule[key] ?? ''}
      placeholder={name.toLowerCase()}
      onChange={(event) => set({ [key]: numberIn(event.target.value) })}
      onBlur={commit}
    />
  );
  switch (rule.kind) {
    case 'int':
    case 'long':
    case 'double':
    case 'decimal':
      return (
        <span className="flex items-center gap-1 text-muted">
          {numberField('min', 'From')}–{numberField('max', 'To')}
          {(rule.kind === 'double' || rule.kind === 'decimal') && (
            <>, {numberField('decimals', 'Decimals', 'w-10')} decimals</>
          )}
        </span>
      );
    case 'sequence':
      return (
        <span className="flex items-center gap-1 text-muted">
          from {numberField('min', 'Start')} by {numberField('max', 'Step', 'w-12')}
        </span>
      );
    case 'words':
    case 'sentence':
      return (
        <span className="flex items-center gap-1 text-muted">
          {numberField('min', 'Fewest words', 'w-10')}–{numberField('max', 'Most words', 'w-10')}{' '}
          words
        </span>
      );
    case 'bool':
      return (
        <span className="flex items-center gap-1 text-muted">
          {numberField('trueShare', 'True share', 'w-12')}% true
        </span>
      );
    case 'date':
      return (
        <span className="flex items-center gap-1 text-muted">
          <input
            aria-label={`From date of ${label}`}
            className={cx(INPUT, 'w-28')}
            value={rule.from ?? ''}
            placeholder="2020-01-01"
            onChange={(event) => set({ from: event.target.value || undefined })}
            onBlur={commit}
          />
          –
          <input
            aria-label={`To date of ${label}`}
            className={cx(INPUT, 'w-28')}
            value={rule.to ?? ''}
            placeholder="now"
            onChange={(event) => set({ to: event.target.value || undefined })}
            onBlur={commit}
          />
        </span>
      );
    case 'pick':
    case 'constant':
      return (
        <input
          aria-label={rule.kind === 'pick' ? `Values of ${label}` : `Value of ${label} (constant)`}
          className={cx(INPUT, 'w-56')}
          value={rule.values ?? ''}
          placeholder={rule.kind === 'pick' ? "['A', 'B', 'C']" : "'fixed'"}
          onChange={(event) => set({ values: event.target.value })}
          onBlur={commit}
        />
      );
    default:
      return null;
  }
}
