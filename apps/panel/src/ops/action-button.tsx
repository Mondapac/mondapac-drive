'use client';

import { Banner, Button, Dialog, TextField, type ButtonVariant } from '@mondapac-drive/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { messageFor } from './errors.ts';
import { useNotice } from './notice.tsx';

export interface ConfirmCopy {
  readonly title: string;
  readonly body: string;
  readonly action: string;
  readonly keep: string;
  /** Ask for a reason, sent as `{ reason }`; the label and its help. */
  readonly reason?: { readonly label: string; readonly help: string; readonly required: string };
}

/**
 * One command of an operations screen: a button that POSTs to the panel's relay with the
 * session's CSRF token, after a confirmation dialog when `confirm` is given (and with a reason
 * when it asks for one). The outcome goes to the screen's live notice and the page is read
 * again. The API checks the permission and the state again, whatever the button showed.
 */
export function ActionButton({
  label,
  name,
  path,
  body = {},
  csrfToken,
  done,
  confirm,
  variant = 'secondary',
  errorScope,
}: {
  readonly label: string;
  /**
   * The button's accessible name when several rows show the same label ("Settle Noor Haddad's
   * line"); it starts with the visible label (WCAG 2.5.3).
   */
  readonly name?: string;
  readonly path: string;
  readonly body?: Readonly<Record<string, unknown>>;
  readonly csrfToken: string;
  /** The notice after success. */
  readonly done: string;
  readonly confirm?: ConfirmCopy;
  readonly variant?: ButtonVariant;
  /** The messages scope whose `error.<code>` keys come before the shared ones. */
  readonly errorScope?: string;
}) {
  const t = useTranslations();
  const router = useRouter();
  const notify = useNotice();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | undefined>(undefined);
  // A ref, not only state: a second click must not start a second request before a render.
  const inFlight = useRef(false);

  async function run(): Promise<void> {
    if (inFlight.current) return;
    if (confirm?.reason !== undefined && reason.trim() === '') {
      setReasonError(confirm.reason.required);
      return;
    }
    inFlight.current = true;
    setPending(true);
    setProblem(null);
    const sent = confirm?.reason === undefined ? body : { ...body, reason: reason.trim() };
    const result = await callApi('POST', path, sent, csrfToken);
    inFlight.current = false;
    setPending(false);
    if (result.ok) {
      setOpen(false);
      setReason('');
      notify({ tone: 'success', text: done });
      router.refresh();
      return;
    }
    const text = messageFor(t, result.failure.code, errorScope);
    if (confirm === undefined) notify({ tone: 'critical', text });
    else setProblem(text);
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void run();
  }

  if (confirm === undefined) {
    return (
      <Button variant={variant} loading={pending} aria-label={name} onClick={() => void run()}>
        {label}
      </Button>
    );
  }
  const formId = `confirm-${path.replaceAll('/', '-')}`;
  return (
    <>
      <Button
        variant={variant}
        aria-label={name}
        onClick={() => {
          setProblem(null);
          setReasonError(undefined);
          setOpen(true);
        }}
      >
        {label}
      </Button>
      <Dialog
        open={open}
        title={confirm.title}
        onClose={() => setOpen(false)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
              {confirm.keep}
            </Button>
            <Button variant="destructive" type="submit" form={formId} loading={pending}>
              {confirm.action}
            </Button>
          </>
        }
      >
        <form id={formId} onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <p>{confirm.body}</p>
          {confirm.reason === undefined ? null : (
            <TextField
              label={confirm.reason.label}
              help={confirm.reason.help}
              value={reason}
              maxLength={500}
              error={reasonError}
              onChange={(event) => {
                setReason(event.target.value);
                setReasonError(undefined);
              }}
            />
          )}
          {problem === null ? null : <Banner tone="critical">{problem}</Banner>}
        </form>
      </Dialog>
    </>
  );
}
