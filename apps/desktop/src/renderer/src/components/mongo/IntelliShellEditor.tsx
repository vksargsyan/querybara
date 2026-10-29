import 'monaco-editor/languages/definitions/javascript/register';
import { splitScript, ShellParseError } from '@querybara/mongo-tools';
import { useEffect, useRef } from 'react';

import { createEditor, EDITOR_FONT, monaco } from '../../lib/monaco';
import type { IntelliShell, RunMode } from '../../state/mongo/intellishell';
import { bindShellModel, registerShellCompletions, unbindShellModel } from './shell-language';

/**
 * IntelliShell's editor (ADR 0036): JavaScript with mongosh's completions, Studio 3T's keys
 * (F5 the whole script, F6 the statement at the cursor, F9 the selection, Shift+Enter the
 * selection or the whole script, Ctrl/Cmd+Enter the selection or the statement), a live syntax
 * check and the last run's error marked where it points.
 */

export interface EditorPosition {
  readonly line: number;
  readonly column: number;
  /** A syntax error in the text as typed, or undefined when it parses. */
  readonly problem: string | undefined;
}

/** What a run takes from the editor: the cursor and the selection, as offsets. */
export interface EditorScope {
  readonly cursor: number;
  readonly selection?: { readonly start: number; readonly end: number };
}

export function IntelliShellEditor(props: {
  readonly shell: IntelliShell;
  readonly value: string;
  readonly theme: 'dark' | 'light';
  readonly fontSize: number;
  readonly issue:
    { readonly offset: number; readonly end?: number; readonly message: string } | undefined;
  readonly onChange: (text: string) => void;
  readonly onRun: (mode: RunMode, scope: EditorScope) => void;
  readonly onPosition: (position: EditorPosition) => void;
  readonly onEditor?: (editor: monaco.editor.IStandaloneCodeEditor) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | undefined>(undefined);
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    registerShellCompletions();
    const model = monaco.editor.createModel(latest.current.value, 'javascript');
    bindShellModel(model, latest.current.shell);
    const editor = createEditor(element, {
      ...EDITOR_FONT,
      model,
      theme: latest.current.theme === 'dark' ? 'querybara-dark' : 'querybara-light',
      automaticLayout: true,
      fontSize: latest.current.fontSize,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      lineNumbersMinChars: 3,
      tabSize: 2,
      ariaLabel: 'IntelliShell script',
      wordBasedSuggestions: 'off',
      quickSuggestions: { other: true, comments: false, strings: false },
      suggestOnTriggerCharacters: true,
      fixedOverflowWidgets: true,
    });
    editorRef.current = editor;

    const scope = (): EditorScope => {
      const selection = editor.getSelection();
      const cursor = model.getOffsetAt(editor.getPosition() ?? { lineNumber: 1, column: 1 });
      if (!selection || selection.isEmpty()) return { cursor };
      return {
        cursor,
        selection: {
          start: model.getOffsetAt(selection.getStartPosition()),
          end: model.getOffsetAt(selection.getEndPosition()),
        },
      };
    };
    const run = (mode: RunMode | 'selectionOrAll' | 'selectionOrStatement') => () => {
      const current = scope();
      const selected = current.selection !== undefined;
      const resolved: RunMode =
        mode === 'selectionOrAll'
          ? selected
            ? 'selection'
            : 'all'
          : mode === 'selectionOrStatement'
            ? selected
              ? 'selection'
              : 'statement'
            : mode;
      latest.current.onRun(resolved, current);
    };
    const actions: [string, string, number[], () => void][] = [
      ['querybara.shell.runAll', 'Run Entire Script', [monaco.KeyCode.F5], run('all')],
      [
        'querybara.shell.runStatement',
        'Run Statement at Cursor',
        [monaco.KeyCode.F6],
        run('statement'),
      ],
      ['querybara.shell.runSelection', 'Run Selection', [monaco.KeyCode.F9], run('selection')],
      [
        'querybara.shell.runSelectionOrAll',
        'Run Selection or Entire Script',
        [monaco.KeyMod.Shift | monaco.KeyCode.Enter],
        run('selectionOrAll'),
      ],
      [
        'querybara.shell.runSelectionOrStatement',
        'Run Selection or Statement',
        [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
        run('selectionOrStatement'),
      ],
    ];
    for (const [id, label, keybindings, action] of actions) {
      editor.addAction({ id, label, keybindings, run: action });
    }

    let check: ReturnType<typeof setTimeout> | undefined;
    const report = (): void => {
      const position = editor.getPosition() ?? { lineNumber: 1, column: 1 };
      let problem: string | undefined;
      try {
        splitScript(model.getValue());
      } catch (error) {
        problem = error instanceof ShellParseError ? error.message : String(error);
      }
      latest.current.onPosition({ line: position.lineNumber, column: position.column, problem });
    };
    const content = model.onDidChangeContent(() => {
      latest.current.onChange(model.getValue());
      if (check !== undefined) clearTimeout(check);
      check = setTimeout(report, 300);
    });
    const cursor = editor.onDidChangeCursorPosition(() => report());
    report();
    latest.current.onEditor?.(editor);
    return () => {
      if (check !== undefined) clearTimeout(check);
      content.dispose();
      cursor.dispose();
      unbindShellModel(model);
      editor.dispose();
      model.dispose();
      editorRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (editor && model && model.getValue() !== props.value) {
      editor.pushUndoStop();
      editor.executeEdits('querybara.set', [
        { range: model.getFullModelRange(), text: props.value },
      ]);
      editor.pushUndoStop();
    }
  }, [props.value]);

  useEffect(() => {
    monaco.editor.setTheme(props.theme === 'dark' ? 'querybara-dark' : 'querybara-light');
  }, [props.theme]);

  useEffect(() => {
    editorRef.current?.updateOptions({ fontSize: props.fontSize });
  }, [props.fontSize]);

  const issue = props.issue;
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    if (!issue) {
      monaco.editor.setModelMarkers(model, 'querybara-shell', []);
      return;
    }
    const start = model.getPositionAt(issue.offset);
    const end = model.getPositionAt(
      Math.min(Math.max(issue.end ?? 0, issue.offset + 1), model.getValueLength()),
    );
    monaco.editor.setModelMarkers(model, 'querybara-shell', [
      {
        severity: monaco.MarkerSeverity.Error,
        message: issue.message,
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: Math.max(end.column, start.column + 1),
      },
    ]);
  }, [issue, props.value]);

  return <div ref={container} data-testid="intellishell-editor" className="h-full min-h-0" />;
}
