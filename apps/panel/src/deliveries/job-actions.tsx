'use client';

import { Banner, Button, Select } from '@mondapac-drive/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { ActionButton } from '../ops/action-button.tsx';
import { messageFor } from '../ops/errors.ts';
import { useNotice } from '../ops/notice.tsx';
import { VEHICLES, type Vehicle } from '../ops/types.ts';
import { ASSIGN_CLOSED, type JobStatus } from './dispatch-job.ts';

export interface JobActionsProps {
  readonly deliveryId: string;
  readonly jobStatus: JobStatus;
  /** The courier the job is assigned to, if any: left out of the picker. */
  readonly assigned: { readonly courierId: string; readonly vehicle: Vehicle } | null;
  /** The vehicle the delivery was quoted for: the form's default without an assignment. */
  readonly quotedVehicle: Vehicle;
  /** Active couriers the session may read; empty when it may not, or none is active. */
  readonly couriers: readonly { readonly accountId: string; readonly name: string }[];
  readonly csrfToken: string;
}

/**
 * A dispatcher's commands on a delivery's dispatch job (`dispatch.job.assign`): assign or
 * reassign the courier, which withdraws the offers still out, and offer it again once every
 * round lapsed. Both are audited by the API, which checks the key and the job's status again.
 */
export function JobActions({
  deliveryId,
  jobStatus,
  assigned,
  quotedVehicle,
  couriers,
  csrfToken,
}: JobActionsProps) {
  const t = useTranslations('deliveries');
  const root = useTranslations();
  const router = useRouter();
  const notify = useNotice();
  const [courierId, setCourierId] = useState('');
  const [vehicle, setVehicle] = useState<string>(assigned?.vehicle ?? quotedVehicle);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const inFlight = useRef(false);
  const base = `dispatch/admin/deliveries/${deliveryId}`;
  const choices = couriers.filter((row) => row.accountId !== assigned?.courierId);

  async function assign(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (inFlight.current) return;
    if (courierId === '' || vehicle === '') {
      setProblem(t('dispatch.required'));
      return;
    }
    inFlight.current = true;
    setPending(true);
    setProblem(null);
    const result = await callApi('POST', `${base}/assign`, { courierId, vehicle }, csrfToken);
    inFlight.current = false;
    setPending(false);
    if (!result.ok) {
      setProblem(messageFor(root, result.failure.code, 'deliveries'));
      // The job moved on (collected or cancelled): show its status as it is now.
      if (result.failure.status === 409) router.refresh();
      return;
    }
    const name = couriers.find((row) => row.accountId === courierId)?.name ?? '';
    setCourierId('');
    notify({ tone: 'success', text: t('dispatch.assigned', { name }) });
    router.refresh();
  }

  if (ASSIGN_CLOSED.has(jobStatus)) return null;
  return (
    <div className="flex flex-col gap-4">
      {jobStatus === 'EXHAUSTED' ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-fg-muted">{t('job.exhausted-help')}</p>
          <div>
            <ActionButton
              label={t('job.redispatch')}
              path={`${base}/redispatch`}
              csrfToken={csrfToken}
              done={t('job.redispatched')}
              variant="primary"
              errorScope="deliveries"
            />
          </div>
        </div>
      ) : null}
      {choices.length === 0 ? (
        <Banner tone="attention">{t('dispatch.no-couriers')}</Banner>
      ) : (
        <form onSubmit={(event) => void assign(event)} className="flex flex-col gap-4" noValidate>
          <Select
            label={t('dispatch.courier')}
            placeholder={t('dispatch.choose-courier')}
            options={choices.map((row) => ({ value: row.accountId, label: row.name }))}
            value={courierId}
            onChange={(event) => setCourierId(event.target.value)}
          />
          <Select
            label={t('dispatch.vehicle')}
            placeholder={t('dispatch.choose-vehicle')}
            options={VEHICLES.map((value) => ({ value, label: t(`vehicle.${value}`) }))}
            value={vehicle}
            onChange={(event) => setVehicle(event.target.value)}
          />
          {problem === null ? null : <Banner tone="critical">{problem}</Banner>}
          <div>
            <Button type="submit" loading={pending} variant="secondary">
              {assigned === null ? t('dispatch.assign') : t('job.reassign')}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
