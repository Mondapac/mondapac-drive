import { Badge, Card, CARD_TABLE, EmptyState, type BadgeTone } from '@mondapac-drive/ui';
import { getLocale, getTranslations } from 'next-intl/server';
import type { ReactNode } from 'react';
import { formatInstant, shortInstant } from '../shared/format.ts';
import { rowName } from '../ops/row-name.ts';
import { shortId } from '../shared/short-id.ts';
import { DecisionButton, type DecisionField } from './decision-button.tsx';
import { DownloadButton } from './download-button.tsx';
import { STATUS_TONE } from './fleet-table.tsx';
import {
  CAPACITY_LIMITS,
  EMPLOYMENT_TYPES,
  REJECTION_REASONS,
  SUSPENSION_REASONS,
  type DocumentStatus,
  type FleetCourier,
} from './types.ts';

const DOCUMENT_TONE: Readonly<Record<DocumentStatus, BadgeTone>> = {
  submitted: 'attention',
  verified: 'success',
  rejected: 'critical',
  revoked: 'neutral',
};

export interface FleetAbilities {
  readonly decide: boolean;
  readonly review: boolean;
  readonly manageVehicles: boolean;
}

/**
 * One fleet courier: their standing and terms with the decisions the session may take, their
 * vehicles (capacity, take out of use) and their documents (download, verify, reject, revoke).
 * Each button shows only for the key and the state the API allows; the API checks both again.
 */
export async function CourierView({
  courier,
  can,
  csrfToken,
}: {
  readonly courier: FleetCourier;
  readonly can: FleetAbilities;
  readonly csrfToken: string;
}) {
  const t = await getTranslations();
  const locale = await getLocale();
  const base = `fleet/admin/couriers/${courier.id}`;
  const number = new Intl.NumberFormat(locale);
  const reasonField = (reasons: readonly string[], scope: string): DecisionField => ({
    kind: 'select',
    name: 'reason',
    label: t('fleet.reason'),
    placeholder: t('fleet.choose-reason'),
    options: reasons.map((value) => ({ value, label: t(`fleet.${scope}.${value}`) })),
  });
  const plateOf = (vehicleId: string | null) => {
    if (vehicleId === null) return null;
    const vehicle = courier.vehicles.find((entry) => entry.id === vehicleId);
    return vehicle?.plate ?? shortId(vehicleId);
  };
  const documentName = (type: string) =>
    t.has(`fleet.document-type.${type}`) ? t(`fleet.document-type.${type}`) : type;
  const live = courier.status !== 'offboarded';

  return (
    <div className="flex flex-col gap-4">
      <Card title={t('fleet.profile.title')}>
        <dl className="grid gap-4 sm:grid-cols-3">
          <Fact label={t('fleet.label.status')}>
            <Badge tone={STATUS_TONE[courier.status]}>{t(`fleet.status.${courier.status}`)}</Badge>
          </Fact>
          <Fact label={t('fleet.label.terms')}>
            {t(`fleet.employment.${courier.employmentType}`)}
          </Fact>
          <Fact label={t('fleet.label.cold-chain')}>
            {courier.coldChainCapable ? t('fleet.yes') : t('fleet.no')}
          </Fact>
          <Fact label={t('fleet.label.tax')}>
            {courier.taxRegistered ? t('fleet.tax.registered') : t('fleet.tax.not-registered')}
          </Fact>
          <Fact label={t('fleet.label.service-area')}>
            <span className="break-words">{courier.serviceAreaCode}</span>
          </Fact>
          <Fact label={t('fleet.label.shift')}>
            {t(`fleet.shift.${courier.shift}`)}
            {courier.idleSince === null ? null : (
              <div className="text-xs text-fg-muted">
                {t('fleet.idle-since', { when: shortInstant(courier.idleSince, locale) })}
              </div>
            )}
          </Fact>
          <Fact label={t('fleet.label.joined')}>{formatInstant(courier.createdAt, locale)}</Fact>
        </dl>
        {can.decide && live ? (
          <div className="flex flex-wrap gap-3">
            {courier.status === 'applicant' ? (
              <DecisionButton
                variant="primary"
                path={`${base}/approve`}
                csrfToken={csrfToken}
                copy={{
                  button: t('fleet.approve.button'),
                  title: t('fleet.approve.title'),
                  body: t('fleet.approve.body'),
                  action: t('fleet.approve.action'),
                  done: t('fleet.approve.done'),
                }}
                fields={[
                  {
                    kind: 'select',
                    name: 'employmentType',
                    label: t('fleet.label.terms'),
                    initial: courier.employmentType,
                    options: EMPLOYMENT_TYPES.map((value) => ({
                      value,
                      label: t(`fleet.employment.${value}`),
                    })),
                  },
                  {
                    kind: 'checkbox',
                    name: 'coldChainCapable',
                    label: t('fleet.approve.cold-chain'),
                    help: t('fleet.approve.cold-chain-help'),
                    initial: courier.coldChainCapable,
                  },
                ]}
              />
            ) : null}
            {courier.status === 'active' ? (
              <DecisionButton
                destructive
                path={`${base}/suspend`}
                csrfToken={csrfToken}
                copy={{
                  button: t('fleet.suspend.button'),
                  title: t('fleet.suspend.title'),
                  body: t('fleet.suspend.body'),
                  action: t('fleet.suspend.action'),
                  done: t('fleet.suspend.done'),
                }}
                fields={[reasonField(SUSPENSION_REASONS, 'suspension')]}
              />
            ) : null}
            {courier.status === 'suspended' ? (
              <DecisionButton
                path={`${base}/reinstate`}
                csrfToken={csrfToken}
                copy={{
                  button: t('fleet.reinstate.button'),
                  title: t('fleet.reinstate.title'),
                  body: t('fleet.reinstate.body'),
                  action: t('fleet.reinstate.action'),
                  done: t('fleet.reinstate.done'),
                }}
              />
            ) : null}
            <DecisionButton
              method="PUT"
              path={`${base}/tax-registration`}
              csrfToken={csrfToken}
              copy={{
                button: t('fleet.tax.button'),
                title: t('fleet.tax.title'),
                body: t('fleet.tax.body'),
                action: t('fleet.tax.action'),
                done: t('fleet.tax.done'),
              }}
              fields={[
                {
                  kind: 'checkbox',
                  name: 'taxRegistered',
                  label: t('fleet.tax.registered'),
                  initial: courier.taxRegistered,
                },
              ]}
            />
            <DecisionButton
              destructive
              path={`${base}/offboard`}
              csrfToken={csrfToken}
              copy={{
                button: t('fleet.offboard.button'),
                title: t('fleet.offboard.title'),
                body: t('fleet.offboard.body'),
                action: t('fleet.offboard.action'),
                done: t('fleet.offboard.done'),
              }}
            />
          </div>
        ) : null}
      </Card>

      <h2 className="mt-2 text-lg font-semibold">{t('fleet.vehicles.title')}</h2>
      {courier.vehicles.length === 0 ? (
        <EmptyState icon="truck" title={t('fleet.vehicles.empty')} />
      ) : (
        <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
          <table className={CARD_TABLE.table}>
            <caption className="sr-only">{t('fleet.vehicles.title')}</caption>
            <thead className={CARD_TABLE.head}>
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">
                  {t('fleet.vehicles.vehicle')}
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  {t('fleet.vehicles.state')}
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  {t('fleet.vehicles.capacity')}
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  {t('fleet.vehicles.cold-box')}
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  <span className="sr-only">{t('fleet.label.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody className={CARD_TABLE.body}>
              {courier.vehicles.map((vehicle) => (
                <tr key={vehicle.id} className={CARD_TABLE.row}>
                  <td className={CARD_TABLE.cell}>
                    <div className="font-medium">{t(`fleet.vehicle-type.${vehicle.type}`)}</div>
                    <div className="break-words text-xs text-fg-muted">
                      {vehicle.plate ?? t('fleet.vehicles.no-plate')}
                    </div>
                  </td>
                  <td className={CARD_TABLE.corner}>
                    <Badge tone={vehicle.active ? 'success' : 'neutral'}>
                      {vehicle.active ? t('fleet.vehicles.active') : t('fleet.vehicles.inactive')}
                    </Badge>
                  </td>
                  <td
                    className={`${CARD_TABLE.labelled} tabular-nums`}
                    data-label={t('fleet.vehicles.capacity')}
                  >
                    {t('fleet.vehicles.capacity-value', {
                      grams: number.format(vehicle.maxWeightGrams),
                      litres: number.format(vehicle.maxVolumeLitres),
                    })}
                  </td>
                  <td className={CARD_TABLE.labelled} data-label={t('fleet.vehicles.cold-box')}>
                    {t(`fleet.cold-box.${vehicle.coldBox}`)}
                  </td>
                  <td className={CARD_TABLE.labelled} data-label={t('fleet.label.actions')}>
                    {can.manageVehicles && vehicle.active ? (
                      <div className="flex flex-wrap gap-2">
                        <DecisionButton
                          name={rowName(
                            t,
                            t('fleet.capacity.button'),
                            vehicle.plate ?? t(`fleet.vehicle-type.${vehicle.type}`),
                          )}
                          method="PUT"
                          path={`${base}/vehicles/${vehicle.id}/capacity`}
                          csrfToken={csrfToken}
                          copy={{
                            button: t('fleet.capacity.button'),
                            title: t('fleet.capacity.title'),
                            body: t('fleet.capacity.body'),
                            action: t('fleet.capacity.action'),
                            done: t('fleet.capacity.done'),
                          }}
                          fields={[
                            {
                              kind: 'integer',
                              name: 'maxWeightGrams',
                              label: t('fleet.capacity.grams'),
                              help: t('fleet.capacity.grams-help'),
                              min: 1,
                              max: CAPACITY_LIMITS.maxWeightGrams,
                              initial: vehicle.maxWeightGrams,
                            },
                            {
                              kind: 'integer',
                              name: 'maxVolumeLitres',
                              label: t('fleet.capacity.litres'),
                              min: 1,
                              max: CAPACITY_LIMITS.maxVolumeLitres,
                              initial: vehicle.maxVolumeLitres,
                            },
                          ]}
                        />
                        <DecisionButton
                          name={rowName(
                            t,
                            t('fleet.deactivate.button'),
                            vehicle.plate ?? t(`fleet.vehicle-type.${vehicle.type}`),
                          )}
                          destructive
                          path={`${base}/vehicles/${vehicle.id}/deactivate`}
                          csrfToken={csrfToken}
                          copy={{
                            button: t('fleet.deactivate.button'),
                            title: t('fleet.deactivate.title'),
                            body: t('fleet.deactivate.body'),
                            action: t('fleet.deactivate.action'),
                            done: t('fleet.deactivate.done'),
                          }}
                        />
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 className="mt-2 text-lg font-semibold">{t('fleet.documents.title')}</h2>
      {courier.documents.length === 0 ? (
        <EmptyState icon="clipboard" title={t('fleet.documents.empty')} />
      ) : (
        <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
          <table className={CARD_TABLE.table}>
            <caption className="sr-only">{t('fleet.documents.title')}</caption>
            <thead className={CARD_TABLE.head}>
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">
                  {t('fleet.documents.document')}
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  {t('fleet.documents.state')}
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  {t('fleet.documents.expires')}
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  {t('fleet.documents.submitted')}
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  <span className="sr-only">{t('fleet.label.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody className={CARD_TABLE.body}>
              {courier.documents.map((document) => {
                const path = `${base}/documents/${document.id}`;
                const plate = plateOf(document.vehicleId);
                const item = documentName(document.type);
                return (
                  <tr key={document.id} className={CARD_TABLE.row}>
                    <td className={CARD_TABLE.cell}>
                      <div className="break-words font-medium">{documentName(document.type)}</div>
                      {plate === null ? null : (
                        <div className="break-words text-xs text-fg-muted">
                          {t('fleet.documents.for-vehicle', { plate })}
                        </div>
                      )}
                    </td>
                    <td className={CARD_TABLE.corner}>
                      <Badge tone={DOCUMENT_TONE[document.status]}>
                        {t(`fleet.document-status.${document.status}`)}
                      </Badge>
                      {document.rejectionReason === null ? null : (
                        <div className="text-xs text-fg-muted">
                          {t(`fleet.rejection.${document.rejectionReason}`)}
                        </div>
                      )}
                    </td>
                    <td className={CARD_TABLE.labelled} data-label={t('fleet.documents.expires')}>
                      {document.expiresAt === null
                        ? t('fleet.documents.no-expiry')
                        : shortInstant(document.expiresAt, locale)}
                    </td>
                    <td className={CARD_TABLE.labelled} data-label={t('fleet.documents.submitted')}>
                      {shortInstant(document.submittedAt, locale)}
                    </td>
                    <td className={CARD_TABLE.labelled} data-label={t('fleet.label.actions')}>
                      {can.review ? (
                        <div className="flex flex-wrap gap-2">
                          <DownloadButton
                            courierId={courier.id}
                            documentId={document.id}
                            label={t('fleet.documents.download')}
                            name={rowName(t, t('fleet.documents.download'), item)}
                          />
                          {document.status === 'submitted' ? (
                            <>
                              <DecisionButton
                                path={`${path}/verify`}
                                name={rowName(t, t('fleet.verify.button'), item)}
                                csrfToken={csrfToken}
                                copy={{
                                  button: t('fleet.verify.button'),
                                  title: t('fleet.verify.title'),
                                  body: t('fleet.verify.body'),
                                  action: t('fleet.verify.action'),
                                  done: t('fleet.verify.done'),
                                }}
                                fields={[
                                  {
                                    kind: 'date',
                                    name: 'expiresAt',
                                    label: t('fleet.verify.expiry'),
                                    help: t('fleet.verify.expiry-help'),
                                    required: false,
                                  },
                                ]}
                              />
                              <DecisionButton
                                destructive
                                path={`${path}/reject`}
                                name={rowName(t, t('fleet.reject.button'), item)}
                                csrfToken={csrfToken}
                                copy={{
                                  button: t('fleet.reject.button'),
                                  title: t('fleet.reject.title'),
                                  body: t('fleet.reject.body'),
                                  action: t('fleet.reject.action'),
                                  done: t('fleet.reject.done'),
                                }}
                                fields={[reasonField(REJECTION_REASONS, 'rejection')]}
                              />
                            </>
                          ) : null}
                          {document.status === 'verified' ? (
                            <DecisionButton
                              destructive
                              path={`${path}/revoke`}
                              name={rowName(t, t('fleet.revoke.button'), item)}
                              csrfToken={csrfToken}
                              copy={{
                                button: t('fleet.revoke.button'),
                                title: t('fleet.revoke.title'),
                                body: t('fleet.revoke.body'),
                                action: t('fleet.revoke.action'),
                                done: t('fleet.revoke.done'),
                              }}
                              fields={[reasonField(REJECTION_REASONS, 'rejection')]}
                            />
                          ) : null}
                        </div>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-sm text-fg-muted">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
