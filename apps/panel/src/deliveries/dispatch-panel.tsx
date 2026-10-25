'use client';

import { Banner, Button, Card, Select } from '@mondapac-drive/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { ActionButton } from '../ops/action-button.tsx';
import { messageFor } from '../ops/errors.ts';
import { useNotice } from '../ops/notice.tsx';
import { CANCELLABLE, VEHICLES, type DeliveryStatus, type Vehicle } from '../ops/types.ts';

export interface DispatchPanelProps {
  readonly deliveryId: string;
  readonly status: DeliveryStatus;
  /** Active couriers the session may read; empty when it may not, or none is active. */
  readonly couriers: readonly { readonly accountId: string; readonly name: string }[];
  /** The vehicle the delivery was quoted for: the default of the assign form. */
  readonly quotedVehicle: Vehicle;
  readonly canDispatch: boolean;
  /** The dispatch job card carries assign and reassign: this panel leaves its form out. */
  readonly assignsOnJob?: boolean;
  readonly canCancel: boolean;
  readonly csrfToken: string;
}

/**
 * The dispatch actions of one delivery, by its status and the session's keys: open dispatch of a
 * scheduled delivery, assign a courier with a vehicle, unassign, and cancel before pickup with a
 * reason. Each is a hint: the API checks the key and the lifecycle again.
 */
export function DispatchPanel({
  deliveryId,
  status,
  couriers,
  quotedVehicle,
  canDispatch,
  assignsOnJob = false,
  canCancel,
  csrfToken,
}: DispatchPanelProps) {
  const t = useTranslations('deliveries');
  const root = useTranslations();
  const router = useRouter();
  const notify = useNotice();
  const [courierId, setCourierId] = useState('');
  const [vehicle, setVehicle] = useState<string>(quotedVehicle);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const inFlight = useRef(false);
  const dispatchPath = `delivery/admin/deliveries/${deliveryId}/dispatch`;

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
    const result = await callApi(
      'POST',
      dispatchPath,
      { type: 'courier_assigned', courierId, vehicle },
      csrfToken,
    );
    inFlight.current = false;
    setPending(false);
    if (!result.ok) {
      setProblem(messageFor(root, result.failure.code, 'deliveries'));
      return;
    }
    const name = couriers.find((row) => row.accountId === courierId)?.name ?? '';
    setCourierId('');
    notify({ tone: 'success', text: t('dispatch.assigned', { name }) });
    router.refresh();
  }

  const showsOpen = canDispatch && status === 'SCHEDULED';
  const showsAssign = canDispatch && !assignsOnJob && status === 'DISPATCHING';
  const showsUnassign = canDispatch && (status === 'ASSIGNED' || status === 'AT_PICKUP');
  const showsCancel = canCancel && CANCELLABLE.has(status);
  if (!showsOpen && !showsAssign && !showsUnassign && !showsCancel) return null;

  return (
    <Card title={t('dispatch.title')}>
      <div className="flex flex-col gap-4">
        {showsOpen ? (
          <div>
            <ActionButton
              label={t('dispatch.open')}
              path={dispatchPath}
              body={{ type: 'dispatch_opened' }}
              csrfToken={csrfToken}
              done={t('dispatch.opened')}
              variant="primary"
              errorScope="deliveries"
            />
          </div>
        ) : null}
        {showsAssign ? (
          couriers.length === 0 ? (
            <Banner tone="attention">{t('dispatch.no-couriers')}</Banner>
          ) : (
            <form
              onSubmit={(event) => void assign(event)}
              className="flex flex-col gap-4"
              noValidate
            >
              <Select
                label={t('dispatch.courier')}
                placeholder={t('dispatch.choose-courier')}
                options={couriers.map((row) => ({ value: row.accountId, label: row.name }))}
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
                <Button type="submit" loading={pending}>
                  {t('dispatch.assign')}
                </Button>
              </div>
            </form>
          )
        ) : null}
        <div className="flex flex-wrap gap-2">
          {showsUnassign ? (
            <ActionButton
              label={t('dispatch.unassign')}
              path={dispatchPath}
              body={{ type: 'courier_unassigned' }}
              csrfToken={csrfToken}
              done={t('dispatch.unassigned')}
              errorScope="deliveries"
            />
          ) : null}
          {showsCancel ? (
            <ActionButton
              label={t('cancel.button')}
              path={`delivery/admin/deliveries/${deliveryId}/cancel`}
              csrfToken={csrfToken}
              done={t('cancel.done')}
              variant="destructive"
              errorScope="deliveries"
              confirm={{
                title: t('cancel.title'),
                body: t('cancel.body'),
                action: t('cancel.action'),
                keep: t('cancel.keep'),
                reason: {
                  label: t('cancel.reason'),
                  help: t('cancel.reason-help'),
                  required: t('cancel.required'),
                },
              }}
            />
          ) : null}
        </div>
      </div>
    </Card>
  );
}
