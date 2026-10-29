import 'monaco-editor/languages/definitions/csharp/register';
import 'monaco-editor/languages/definitions/go/register';
import 'monaco-editor/languages/definitions/java/register';
import 'monaco-editor/languages/definitions/php/register';
import 'monaco-editor/languages/definitions/python/register';
import { CODE_EXPORT_LANGUAGES, type CodeLanguage } from '@querybara/mongo-tools';
import { useMemo, useState, type ReactNode } from 'react';

import { copyToClipboard } from '../../lib/clipboard';
import { errorMessage } from '../../lib/errors';
import {
  exportLanguage,
  exportSubject,
  exportedCode,
  lastExportLanguage,
  rememberExportLanguage,
  saveExportedCode,
  type CodeExportRequest,
} from '../../state/mongo/code-export';
import { useTheme } from '../theme';
import { Button, Modal, cx } from '../ui';
import { Banner, Segmented } from './parts';
import { ShellEditor } from './ShellEditor';

/**
 * The code export dialog (spec §9, "Query tools"): the query as a complete program in the
 * language picked, highlighted, with the official driver and how to install it; Copy puts the
 * program on the clipboard and Save as writes it where the user picks. The collection tab shows
 * the same view inline as its Query Code section (ADR 0036).
 */
export function CodeExportDialog(props: {
  /** What to export; the dialog is closed while undefined. */
  readonly request: CodeExportRequest | undefined;
  readonly onClose: () => void;
}) {
  const { request } = props;
  return (
    <Modal
      open={request !== undefined}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
      title="Export code"
      {...(request ? { description: exportSubject(request) } : {})}
      width="w-[min(860px,94vw)]"
    >
      {request && <CodeExportView request={request} onClose={props.onClose} />}
    </Modal>
  );
}

/** The language picker, the program and its actions; `actions` adds buttons before Copy. */
export function CodeExportView(props: {
  readonly request: CodeExportRequest;
  readonly onClose?: () => void;
  readonly actions?: ReactNode;
  /** Fills its container (the collection tab) instead of the dialog's fixed height. */
  readonly fill?: boolean;
}) {
  const theme = useTheme();
  const [id, setId] = useState<CodeLanguage>(lastExportLanguage);
  const [status, setStatus] = useState<{ kind: 'success' | 'error'; text: string } | undefined>();
  const language = exportLanguage(id);
  const result = useMemo(() => exportedCode(props.request, id), [props.request, id]);
  const code = 'code' in result ? result.code : undefined;

  const pick = (next: CodeLanguage): void => {
    setId(next);
    rememberExportLanguage(next);
    setStatus(undefined);
  };
  const copy = (text: string, what: string): void => {
    setStatus(
      copyToClipboard(text)
        ? { kind: 'success', text: `${what} copied to the clipboard` }
        : { kind: 'error', text: 'The clipboard could not be written' },
    );
  };
  const save = async (): Promise<void> => {
    if (code === undefined) return;
    try {
      const path = await saveExportedCode(code, language);
      if (path !== null) setStatus({ kind: 'success', text: `Saved to ${path}` });
    } catch (error) {
      setStatus({ kind: 'error', text: errorMessage(error) });
    }
  };

  return (
    <div
      className={cx('flex flex-col gap-3', props.fill && 'h-full min-h-0 p-3')}
      data-testid="code-export"
    >
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="Language"
          value={id}
          options={CODE_EXPORT_LANGUAGES.map((option) => ({
            value: option.id,
            label: option.label,
          }))}
          onChange={pick}
        />
        <span className="flex-1" />
        <span className="text-xs text-muted">
          Driver <span className="text-fg">{language.driver}</span>
        </span>
      </div>
      <div className="flex items-center gap-2 rounded border border-border bg-panel-2 px-2.5 py-1.5">
        <span className="text-[11px] font-medium tracking-wide text-muted uppercase">Install</span>
        <code
          className="min-w-0 flex-1 truncate font-mono text-xs select-text"
          data-testid="code-export-install"
        >
          {language.install}
        </code>
        <Button size="sm" variant="ghost" onClick={() => copy(language.install, 'The command')}>
          Copy
        </Button>
      </div>
      {'error' in result ? (
        <Banner kind="error">{result.error}</Banner>
      ) : (
        <div
          className={cx(
            'overflow-hidden rounded border border-border',
            props.fill ? 'min-h-0 flex-1' : 'h-[min(420px,55vh)]',
          )}
        >
          <ShellEditor
            value={result.code}
            onChange={() => undefined}
            readOnly
            language={language.editorLanguage}
            theme={theme}
            ariaLabel={`${language.label} code`}
            testId="code-export-editor"
          />
        </div>
      )}
      <p className="text-xs text-muted">
        The program reads the connection string from{' '}
        <span className="font-mono text-fg">MONGODB_URI</span>, so it holds no credentials. Save it
        as <span className="font-mono text-fg">{language.fileName}</span> and run it with the driver
        installed.
      </p>
      <div className="flex items-center gap-2 border-t border-border pt-3">
        <span
          className={cx(
            'min-w-0 flex-1 truncate text-xs',
            status?.kind === 'error' ? 'text-danger' : 'text-muted',
          )}
          role="status"
          data-testid="code-export-status"
        >
          {status?.text}
        </span>
        {props.actions}
        {props.onClose && (
          <Button variant="ghost" onClick={props.onClose}>
            Close
          </Button>
        )}
        <Button
          variant="secondary"
          disabled={code === undefined}
          onClick={() => code !== undefined && copy(code, 'The code')}
        >
          Copy code
        </Button>
        <Button variant="primary" disabled={code === undefined} onClick={() => void save()}>
          Save as…
        </Button>
      </div>
    </div>
  );
}
