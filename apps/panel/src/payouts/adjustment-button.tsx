'use client';

import { Banner, Button, Dialog, Select, TextField } from '@mondapac-drive/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { messageFor } from '../ops/errors.ts';
import { useNotice } from '../ops/notice.tsx';
import { toMinorUnits } from './amount.ts';
import { ADJUSTMENT_REASONS, type AdjustmentReason } from './types.ts';

/**
 * Credit or debit a courier's balance (protected `payouts.adjustment.record`, audited). One
 * idempotency key per intent (direction, amount, reason), kept until the API confirms it: a
 * retry after a lost answer, also after closing and reopening the dialog, records nothing new
 * (security review, L1). A success, or a different intent, takes a new key.
 */
export function AdjustmentButton({
  courierId,
  currency,
  csrfToken,
}: {
  readonly courierId: string;
  /** The courier's balance currency (the Market's). */
  readonly currency: string;
  readonly csrfToken: string;
}) {
  const t = useTranslations('payouts.adjust');
  const root = useTranslations();
  const router = useRouter();
  const notify = useNotice();
  const [open, setOpen] = useState(false);
  const [direction, setDirection] = useState<'credit' | 'debit'>('credit');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState<AdjustmentReason | ''>('');
  const [errors, setErrors] = useState<{ amount?: string; reason?: string }>({});
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** The last intent sent without a confirmed answer, and its key. */
  const unconfirmed = useRef<{ readonly intent: string; readonly key: string } | null>(null);
  const inFlight = useRef(false);

  function start(): void {
    // An unconfirmed attempt keeps its fields, so the same intent is sent with the same key.
    if (unconfirmed.current === null) {
      setDirection('credit');
      setAmount('');
      setReason('');
    }
    setErrors({});
    setProblem(null);
    setOpen(true);
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (inFlight.current) return;
    const minor = toMinorUnits(amount, currency, direction);
    const found = {
      ...(minor === null ? { amount: t('amount-invalid') } : {}),
      ...(reason === '' ? { reason: t('reason-required') } : {}),
    };
    setErrors(found);
    if (minor === null || reason === '') return;
    const intent = `${minor}|${reason}`;
    if (unconfirmed.current?.intent !== intent) {
      unconfirmed.current = { intent, key: `adj:${crypto.randomUUID()}` };
    }
    const { key } = unconfirmed.current;
    inFlight.current = true;
    setPending(true);
    setProblem(null);
    const result = await callApi<{ readonly recorded: boolean }>(
      'POST',
      `payouts/admin/couriers/${courierId}/adjustments`,
      { amount: { amount: minor, currency }, reason, key },
      csrfToken,
    );
    inFlight.current = false;
    setPending(false);
    if (!result.ok) {
      // A refusal the API answered for sure (4xx) recorded nothing: the next try is a new intent.
      const answered = result.failure.status >= 400 && result.failure.status < 500;
      if (answered) unconfirmed.current = null;
      setProblem(messageFor(root, result.failure.code, 'payouts'));
      return;
    }
    unconfirmed.current = null;
    setOpen(false);
    notify({ tone: 'success', text: result.body.recorded ? t('done') : t('already') });
    router.refresh();
  }

  const formId = `adjust-${courierId}`;
  return (
    <>
      <Button onClick={start}>{t('button')}</Button>
      <Dialog
        open={open}
        title={t('title')}
        onClose={() => setOpen(false)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
              {root('ops.cancel')}
            </Button>
            <Button type="submit" form={formId} loading={pending}>
              {t('action')}
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
          <p>{t('body')}</p>
          <Select
            label={t('direction')}
            value={direction}
            options={[
              { value: 'credit', label: t('credit') },
              { value: 'debit', label: t('debit') },
            ]}
            onChange={(event) => setDirection(event.target.value === 'debit' ? 'debit' : 'credit')}
          />
          <TextField
            label={t('amount', { currency })}
            help={t('amount-help')}
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            maxLength={17}
            error={errors.amount}
            onChange={(event) => {
              setAmount(event.target.value);
              setErrors((now) => ({ ...now, amount: undefined }));
            }}
          />
          <Select
            label={t('reason')}
            placeholder={t('choose-reason')}
            value={reason}
            error={errors.reason}
            options={ADJUSTMENT_REASONS.map((value) => ({
              value,
              label: root(`payouts.reason.${value}`),
            }))}
            onChange={(event) => {
              const value = event.target.value;
              setReason(
                (ADJUSTMENT_REASONS as readonly string[]).includes(value)
                  ? (value as AdjustmentReason)
                  : '',
              );
              setErrors((now) => ({ ...now, reason: undefined }));
            }}
          />
          {problem === null ? null : <Banner tone="critical">{problem}</Banner>}
        </form>
      </Dialog>
    </>
  );
}
