import type { CellValue } from '@querybara/core';
import { useState } from 'react';

import { useDialogs, type Prompt } from '../state/dialogs';
import { describeReason } from '../state/run-plan';
import { Button, Field, Input, Modal } from './ui';

/** Shows the first queued prompt (safety confirmation, parameters, secrets, confirmations). */
export function Prompts() {
  const prompt = useDialogs((state) => state.queue[0]);
  if (!prompt) return null;
  switch (prompt.kind) {
    case 'confirm-run':
      return <ConfirmRun prompt={prompt} />;
    case 'parameters':
      return <Parameters key={prompt.prompts.map((p) => p.key).join()} prompt={prompt} />;
    case 'secrets':
      return <Secrets prompt={prompt} />;
    case 'confirm':
      return <Confirm prompt={prompt} />;
    case 'shell':
      return <ShellQuestion prompt={prompt} />;
  }
}

function ConfirmRun({ prompt }: { readonly prompt: Extract<Prompt, { kind: 'confirm-run' }> }) {
  return (
    <Modal
      open
      role="alertdialog"
      onOpenChange={(open) => !open && prompt.resolve(false)}
      title={prompt.production ? 'Run on a production connection?' : 'Run these statements?'}
      description={
        prompt.production
          ? 'This connection is marked production, so every write asks first.'
          : 'Some statements can change or remove a lot of data.'
      }
      width="w-[640px]"
      footer={
        <>
          <Button variant="ghost" onClick={() => prompt.resolve(false)}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => prompt.resolve(true)} autoFocus={false}>
            Run anyway
          </Button>
        </>
      }
    >
      <ul className="flex flex-col gap-3" data-testid="safety-reasons">
        {prompt.statements.map((statement) => (
          <li key={statement.index} className="rounded border border-border bg-panel-2 p-2">
            <pre className="max-h-28 overflow-auto font-mono text-xs whitespace-pre-wrap">
              {statement.text}
            </pre>
            <ul className="mt-1.5 list-disc pl-5 text-xs text-warning">
              {statement.reasons.map((reason) => (
                <li key={reason}>{describeReason(reason)}</li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

function Parameters({ prompt }: { readonly prompt: Extract<Prompt, { kind: 'parameters' }> }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [nulls, setNulls] = useState<Record<string, boolean>>({});
  const submit = (): void => {
    const answers = new Map<string, CellValue>();
    for (const { key } of prompt.prompts) {
      answers.set(key, nulls[key] ? null : (values[key] ?? ''));
    }
    prompt.resolve(answers);
  };
  return (
    <Modal
      open
      onOpenChange={(open) => !open && prompt.resolve(null)}
      title="Parameter values"
      description="Values are sent as bound parameters, never pasted into the SQL."
      footer={
        <>
          <Button variant="ghost" onClick={() => prompt.resolve(null)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit}>
            Run
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {prompt.prompts.map((parameter, index) => (
          <div key={parameter.key} className="flex items-end gap-3">
            <Field label={parameter.label} htmlFor={`param-${index}`} className="flex-1">
              <Input
                id={`param-${index}`}
                autoFocus={index === 0}
                disabled={nulls[parameter.key] === true}
                value={values[parameter.key] ?? ''}
                onChange={(event) => setValues({ ...values, [parameter.key]: event.target.value })}
              />
            </Field>
            <label className="flex h-8 items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={nulls[parameter.key] === true}
                onChange={(event) => setNulls({ ...nulls, [parameter.key]: event.target.checked })}
              />
              NULL
            </label>
          </div>
        ))}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function Secrets({ prompt }: { readonly prompt: Extract<Prompt, { kind: 'secrets' }> }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const submit = (): void => {
    const answers: Record<string, string> = {};
    for (const ref of prompt.missing) answers[ref.refId] = values[ref.refId] ?? '';
    prompt.resolve(answers);
  };
  return (
    <Modal
      open
      onOpenChange={(open) => !open && prompt.resolve(null)}
      title={`Connect to ${prompt.profileName}`}
      description="The password is used for this connection only and is not shown again."
      footer={
        <>
          <Button variant="ghost" onClick={() => prompt.resolve(null)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit}>
            Connect
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {prompt.missing.map((ref, index) => (
          <Field
            key={ref.refId}
            label={ref.label ?? (prompt.missing.length === 1 ? 'Password' : `Secret ${index + 1}`)}
            htmlFor={`secret-${index}`}
            hint={
              ref.unreadable
                ? 'The saved password cannot be read on this system any more; enter it again.'
                : ref.policy === 'session'
                  ? 'Remembered until Querybara quits.'
                  : undefined
            }
          >
            <Input
              id={`secret-${index}`}
              type="password"
              autoComplete="off"
              autoFocus={index === 0}
              value={values[ref.refId] ?? ''}
              onChange={(event) => setValues({ ...values, [ref.refId]: event.target.value })}
            />
          </Field>
        ))}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function Confirm({ prompt }: { readonly prompt: Extract<Prompt, { kind: 'confirm' }> }) {
  return (
    <Modal
      open
      role="alertdialog"
      onOpenChange={(open) => !open && prompt.resolve(false)}
      title={prompt.title}
      footer={
        <>
          <Button variant="ghost" onClick={() => prompt.resolve(false)}>
            Cancel
          </Button>
          <Button
            variant={prompt.danger ? 'danger' : 'primary'}
            onClick={() => prompt.resolve(true)}
          >
            {prompt.confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-[13px]">{prompt.message}</p>
      {prompt.detail !== undefined && (
        <pre
          data-testid="confirm-detail"
          className="mt-3 max-h-48 overflow-auto rounded border border-border bg-panel-2 p-2 font-mono text-xs whitespace-pre-wrap select-text"
        >
          {prompt.detail}
        </pre>
      )}
    </Modal>
  );
}

/**
 * IntelliShell's questions (ADR 0036): a write the profile's rules ask about, with Run for this
 * one and Run all for the rest of the script, or a password the script prompts for.
 */
function ShellQuestion({ prompt }: { readonly prompt: Extract<Prompt, { kind: 'shell' }> }) {
  const [text, setText] = useState('');
  const { kind, question, operation } = prompt.prompt;
  if (kind === 'password' || kind === 'confirm') {
    const password = kind === 'password';
    return (
      <Modal
        open
        role={password ? 'dialog' : 'alertdialog'}
        onOpenChange={(open) => !open && prompt.resolve({ kind: 'deny' })}
        title={password ? 'The script asks for a password' : 'The script asks'}
        footer={
          <>
            <Button variant="ghost" onClick={() => prompt.resolve({ kind: 'deny' })}>
              {password ? 'Cancel' : 'No'}
            </Button>
            <Button
              variant="primary"
              onClick={() =>
                prompt.resolve(password ? { kind: 'text', text } : { kind: 'allow', scope: 'once' })
              }
            >
              {password ? 'OK' : 'Yes'}
            </Button>
          </>
        }
      >
        <p className="text-[13px] whitespace-pre-wrap">{question}</p>
        {password && (
          <form
            className="mt-3"
            onSubmit={(event) => {
              event.preventDefault();
              prompt.resolve({ kind: 'text', text });
            }}
          >
            <Input
              type="password"
              autoComplete="off"
              autoFocus
              aria-label="Password"
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </form>
        )}
      </Modal>
    );
  }
  const destructive = kind === 'destructive';
  return (
    <Modal
      open
      role="alertdialog"
      onOpenChange={(open) => !open && prompt.resolve({ kind: 'deny' })}
      title={
        prompt.production
          ? 'Write on a production connection?'
          : destructive
            ? 'Run this operation?'
            : 'Run this write?'
      }
      description={
        destructive
          ? 'It can remove or change a lot of data.'
          : `"${prompt.connectionName}" asks before every write.`
      }
      footer={
        <>
          <Button variant="ghost" onClick={() => prompt.resolve({ kind: 'deny' })}>
            Don’t run
          </Button>
          <Button
            variant="ghost"
            onClick={() => prompt.resolve({ kind: 'allow', scope: 'run' })}
            title="Run this write and every other one this script makes"
          >
            Run all writes
          </Button>
          <Button variant="danger" onClick={() => prompt.resolve({ kind: 'allow', scope: 'once' })}>
            Run
          </Button>
        </>
      }
    >
      <p className="text-[13px]">{question}</p>
      {operation !== undefined && (
        <pre
          data-testid="shell-prompt-operation"
          className="mt-3 rounded border border-border bg-panel-2 p-2 font-mono text-xs whitespace-pre-wrap select-text"
        >
          {operation}
        </pre>
      )}
    </Modal>
  );
}
