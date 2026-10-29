import 'monaco-editor/languages/definitions/javascript/register';

import { monaco } from '../../lib/monaco';
import type { IntelliShell } from '../../state/mongo/intellishell';
import { completionContext, completionInsert, fieldKey } from '../../state/mongo/shell-completion';

/**
 * IntelliShell's autocompletion in Monaco (ADR 0036): mongosh's own completer (shell methods,
 * collections, operators), through the connection host, plus field names sampled from the
 * collection a query document is about. Only editors bound to a shell get them; the other
 * JavaScript editors (the query bar's find() text) keep none.
 */

const shells = new Map<string, IntelliShell>();

export function bindShellModel(model: monaco.editor.ITextModel, shell: IntelliShell): void {
  shells.set(model.uri.toString(), shell);
}

export function unbindShellModel(model: monaco.editor.ITextModel): void {
  shells.delete(model.uri.toString());
}

let registered = false;

/** Registers the completion provider for bound JavaScript models (once). */
export function registerShellCompletions(): void {
  if (registered) return;
  registered = true;
  monaco.languages.registerCompletionItemProvider('javascript', {
    triggerCharacters: ['.', '$'],
    async provideCompletionItems(model, position) {
      const shell = shells.get(model.uri.toString());
      if (!shell) return { suggestions: [] };
      const before = model.getValueInRange({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });
      const context = completionContext(before);
      const target = context.fieldsOf;
      const [candidates, fields] = await Promise.all([
        shell.complete(context.line),
        target ? shell.fields(target.db ?? shell.state.database ?? 'test', target.collection) : [],
      ]);
      const range = new monaco.Range(
        position.lineNumber,
        position.column - context.word.length,
        position.lineNumber,
        position.column,
      );
      const seen = new Set<string>();
      const suggestions: monaco.languages.CompletionItem[] = [];
      for (const path of fields) {
        const key = fieldKey(path);
        if (seen.has(key)) continue;
        seen.add(key);
        suggestions.push({
          label: { label: key, description: 'field' },
          kind: monaco.languages.CompletionItemKind.Field,
          insertText: key,
          sortText: `0${key}`,
          range,
        });
      }
      for (const candidate of candidates) {
        const insert = completionInsert(context, candidate);
        if (insert === undefined || seen.has(insert)) continue;
        seen.add(insert);
        suggestions.push({
          label: insert,
          kind: insert.startsWith('$')
            ? monaco.languages.CompletionItemKind.Operator
            : monaco.languages.CompletionItemKind.Method,
          insertText: insert,
          sortText: `1${insert}`,
          range,
        });
      }
      return { suggestions };
    },
  });
}
