'use client';

import { Banner, Button, Dialog, TextField } from '@mondapac-drive/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { messageFor } from './errors.ts';
import { useNotice } from './notice.tsx';

export interface FormCopy {
  readonly button: string;
  readonly title: string;
  readonly label: string;
  readonly help: string;
  readonly action: string;
  readonly cancel: string;
  /** The notice after success; `{value}` is what was typed. */
  readonly done: (value: string) => string;
}

/**
 * A primary action with one text field in a dialog (add a merchant, invite a courier): POSTs
 * `{ [field]: value }` with the CSRF token, then shows the notice and reads the page again.
 * `onDone` takes the answer instead of the notice when the caller has more to show.
 */
export function FormButton<T>({
  copy,
  path,
  field,
  type = 'text',
  maxLength,
  csrfToken,
  onDone,
}: {
  readonly copy: FormCopy;
  readonly path: string;
  readonly field: string;
  readonly type?: 'text' | 'email';
  readonly maxLength: number;
  readonly csrfToken: string;
  readonly onDone?: (answer: T) => void;
}) {
  const t = useTranslations();
  const router = useRouter();
  const notify = useNotice();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const inFlight = useRef(false);
  const formId = `form-${path.replaceAll('/', '-')}`;

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (inFlight.current) return;
    const text = value.trim();
    if (text === '') {
      setProblem(messageFor(t, 'validation.failed'));
      return;
    }
    inFlight.current = true;
    setPending(true);
    setProblem(null);
    const result = await callApi<T>('POST', path, { [field]: text }, csrfToken);
    inFlight.current = false;
    setPending(false);
    if (!result.ok) {
      setProblem(messageFor(t, result.failure.code));
      return;
    }
    setOpen(false);
    setValue('');
    if (onDone === undefined) notify({ tone: 'success', text: copy.done(text) });
    else onDone(result.body);
    router.refresh();
  }

  return (
    <>
      <Button
        onClick={() => {
          setProblem(null);
          setOpen(true);
        }}
      >
        {copy.button}
      </Button>
      <Dialog
        open={open}
        title={copy.title}
        onClose={() => setOpen(false)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
              {copy.cancel}
            </Button>
            <Button type="submit" form={formId} loading={pending}>
              {copy.action}
            </Button>
          </>
        }
      >
        <form id={formId} onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
          <TextField
            label={copy.label}
            help={copy.help}
            type={type}
            value={value}
            maxLength={maxLength}
            required
            autoComplete="off"
            onChange={(event) => setValue(event.target.value)}
          />
          {problem === null ? null : <Banner tone="critical">{problem}</Banner>}
        </form>
      </Dialog>
    </>
  );
}
