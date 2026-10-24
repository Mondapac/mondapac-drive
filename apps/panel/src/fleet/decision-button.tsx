'use client';

import { Banner, Button, CheckboxRow, Dialog, Select, TextField } from '@mondapac-drive/ui';
import type { ButtonVariant } from '@mondapac-drive/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { messageFor } from '../ops/errors.ts';
import { useNotice } from '../ops/notice.tsx';

/** A field of a decision's dialog; its value is sent under `name`. */
export type DecisionField =
  | {
      readonly kind: 'select';
      readonly name: string;
      readonly label: string;
      readonly options: readonly { readonly value: string; readonly label: string }[];
      /** No preset: the operator picks a value (a reason), so none is sent by mistake. */
      readonly placeholder?: string;
      readonly initial?: string;
    }
  | {
      readonly kind: 'checkbox';
      readonly name: string;
      readonly label: string;
      readonly help?: string;
      readonly initial: boolean;
    }
  | {
      /** A calendar day, sent as the end of that day in the admin's time zone. */
      readonly kind: 'date';
      readonly name: string;
      readonly label: string;
      readonly help?: string;
      readonly required: boolean;
    }
  | {
      readonly kind: 'integer';
      readonly name: string;
      readonly label: string;
      readonly help?: string;
      readonly min: number;
      readonly max: number;
      readonly initial: number;
    };

export interface DecisionCopy {
  readonly button: string;
  readonly title: string;
  readonly body: string;
  readonly action: string;
  readonly done: string;
}

type Values = Readonly<Record<string, string | boolean>>;

const initialValues = (fields: readonly DecisionField[]): Values =>
  Object.fromEntries(
    fields.map((field) => [
      field.name,
      field.kind === 'checkbox'
        ? field.initial
        : field.kind === 'integer'
          ? String(field.initial)
          : field.kind === 'select'
            ? (field.initial ?? '')
            : '',
    ]),
  );

/** The instant a day ends in the browser's time zone; null when the text is not a real day. */
export function endOfDay(day: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) return null;
  const [year, month, date] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const end = new Date(year, month - 1, date, 23, 59, 59);
  if (end.getFullYear() !== year || end.getMonth() !== month - 1 || end.getDate() !== date) {
    return null;
  }
  return end.toISOString();
}

/**
 * The body of a decision, or the fields that are wrong. Pure, so the shapes the API takes are
 * tested without a dialog.
 */
export function decisionBody(
  fields: readonly DecisionField[],
  values: Values,
): { readonly body: Record<string, unknown> } | { readonly wrong: readonly string[] } {
  const body: Record<string, unknown> = {};
  const wrong: string[] = [];
  for (const field of fields) {
    const value = values[field.name];
    switch (field.kind) {
      case 'checkbox':
        body[field.name] = value === true;
        break;
      case 'select':
        if (typeof value === 'string' && field.options.some((option) => option.value === value)) {
          body[field.name] = value;
        } else wrong.push(field.name);
        break;
      case 'integer': {
        const text = typeof value === 'string' ? value.trim() : '';
        const number = /^\d{1,9}$/.test(text) ? Number(text) : Number.NaN;
        if (Number.isInteger(number) && number >= field.min && number <= field.max) {
          body[field.name] = number;
        } else wrong.push(field.name);
        break;
      }
      case 'date': {
        const text = typeof value === 'string' ? value.trim() : '';
        if (text === '') {
          if (field.required) wrong.push(field.name);
          break;
        }
        const instant = endOfDay(text);
        if (instant === null) wrong.push(field.name);
        else body[field.name] = instant;
        break;
      }
    }
  }
  return wrong.length === 0 ? { body } : { wrong };
}

/**
 * One fleet decision: a button that opens a dialog with the decision's fields, then sends them
 * to the panel's relay with the session's CSRF token. The fields start from the courier's own
 * values each time the dialog opens; a reason is never preset. The API checks the permission
 * and the courier's state again, and audits the decision.
 */
export function DecisionButton({
  copy,
  method = 'POST',
  path,
  fields = [],
  csrfToken,
  variant = 'secondary',
  destructive = false,
}: {
  readonly copy: DecisionCopy;
  readonly method?: 'POST' | 'PUT';
  readonly path: string;
  readonly fields?: readonly DecisionField[];
  readonly csrfToken: string;
  readonly variant?: ButtonVariant;
  readonly destructive?: boolean;
}) {
  const t = useTranslations();
  const router = useRouter();
  const notify = useNotice();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Values>(() => initialValues(fields));
  const [wrong, setWrong] = useState<readonly string[]>([]);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const inFlight = useRef(false);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (inFlight.current) return;
    const built = decisionBody(fields, values);
    if ('wrong' in built) {
      setWrong(built.wrong);
      return;
    }
    inFlight.current = true;
    setPending(true);
    setProblem(null);
    const result = await callApi(method, path, built.body, csrfToken);
    inFlight.current = false;
    setPending(false);
    if (!result.ok) {
      setProblem(messageFor(t, result.failure.code, 'fleet'));
      return;
    }
    setOpen(false);
    notify({ tone: 'success', text: copy.done });
    router.refresh();
  }

  const set = (name: string, value: string | boolean) => {
    setValues((now) => ({ ...now, [name]: value }));
    setWrong((now) => now.filter((field) => field !== name));
  };
  const errorOf = (name: string) => (wrong.includes(name) ? t('fleet.field-invalid') : undefined);
  const formId = `fleet-${method}-${path.replaceAll('/', '-')}`;

  return (
    <>
      <Button
        variant={variant}
        onClick={() => {
          setValues(initialValues(fields));
          setWrong([]);
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
              {t('ops.cancel')}
            </Button>
            <Button
              variant={destructive ? 'destructive' : 'primary'}
              type="submit"
              form={formId}
              loading={pending}
            >
              {copy.action}
            </Button>
          </>
        }
      >
        <form
          id={formId}
          onSubmit={(event) => void submit(event)}
          className="flex flex-col gap-4"
          noValidate
        >
          <p>{copy.body}</p>
          {fields.map((field) => {
            const value = values[field.name];
            switch (field.kind) {
              case 'select':
                return (
                  <Select
                    key={field.name}
                    label={field.label}
                    {...(field.placeholder === undefined ? {} : { placeholder: field.placeholder })}
                    value={typeof value === 'string' ? value : ''}
                    options={field.options}
                    error={errorOf(field.name)}
                    onChange={(event) => set(field.name, event.target.value)}
                  />
                );
              case 'checkbox':
                return (
                  <CheckboxRow
                    key={field.name}
                    label={field.label}
                    {...(field.help === undefined ? {} : { help: field.help })}
                    checked={value === true}
                    onChange={(event) => set(field.name, event.target.checked)}
                  />
                );
              case 'date':
                return (
                  <TextField
                    key={field.name}
                    type="date"
                    label={field.label}
                    help={field.help}
                    value={typeof value === 'string' ? value : ''}
                    error={errorOf(field.name)}
                    onChange={(event) => set(field.name, event.target.value)}
                  />
                );
              case 'integer':
                return (
                  <TextField
                    key={field.name}
                    label={field.label}
                    help={field.help}
                    inputMode="numeric"
                    autoComplete="off"
                    maxLength={9}
                    value={typeof value === 'string' ? value : ''}
                    error={errorOf(field.name)}
                    onChange={(event) => set(field.name, event.target.value)}
                  />
                );
            }
          })}
          {problem === null ? null : <Banner tone="critical">{problem}</Banner>}
        </form>
      </Dialog>
    </>
  );
}
