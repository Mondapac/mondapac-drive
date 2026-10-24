import { Badge, CARD_TABLE, EmptyState, type BadgeTone } from '@mondapac-drive/ui';
import { getLocale, getTranslations } from 'next-intl/server';
import { shortInstant } from '../shared/format.ts';
import { shortId } from '../shared/short-id.ts';
import type { CourierStatus, CourierSummary } from './types.ts';

export const STATUS_TONE: Readonly<Record<CourierStatus, BadgeTone>> = {
  applicant: 'info',
  active: 'success',
  suspended: 'attention',
  offboarded: 'neutral',
};

/**
 * The Market's fleet couriers: fleet id, standing, terms, shift, active vehicles and the
 * documents waiting for review. A row links to the courier's vehicles and documents.
 */
export async function FleetTable({
  couriers,
  firstPage,
}: {
  readonly couriers: readonly CourierSummary[];
  readonly firstPage: boolean;
}) {
  const t = await getTranslations();
  const locale = await getLocale();
  if (couriers.length === 0) {
    return firstPage ? (
      <EmptyState icon="truck" title={t('fleet.empty.title')} body={t('fleet.empty.body')} />
    ) : (
      <p className="text-fg-muted">{t('fleet.empty.page')}</p>
    );
  }
  return (
    <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
      <table className={CARD_TABLE.table}>
        <caption className="sr-only">{t('fleet.table-caption')}</caption>
        <thead className={CARD_TABLE.head}>
          <tr>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('fleet.label.courier')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('fleet.label.status')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('fleet.label.terms')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('fleet.label.shift')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('fleet.label.vehicles')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('fleet.label.to-review')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('fleet.label.joined')}
            </th>
          </tr>
        </thead>
        <tbody className={CARD_TABLE.body}>
          {couriers.map((courier) => (
            <tr key={courier.id} className={CARD_TABLE.row}>
              <td className={CARD_TABLE.cell}>
                <a
                  className="inline-flex min-h-12 items-center break-words font-medium text-link underline"
                  href={`/fleet/couriers/${courier.id}`}
                >
                  {t('fleet.courier-ref', { id: shortId(courier.id) })}
                </a>
                <div className="break-words text-xs text-fg-muted">{courier.serviceAreaCode}</div>
              </td>
              <td className={CARD_TABLE.corner}>
                <Badge tone={STATUS_TONE[courier.status]}>
                  {t(`fleet.status.${courier.status}`)}
                </Badge>
              </td>
              <td className={CARD_TABLE.labelled} data-label={t('fleet.label.terms')}>
                {t(`fleet.employment.${courier.employmentType}`)}
                {courier.coldChainCapable ? (
                  <div className="text-xs text-fg-muted">{t('fleet.cold-chain')}</div>
                ) : null}
              </td>
              <td className={CARD_TABLE.labelled} data-label={t('fleet.label.shift')}>
                {t(`fleet.shift.${courier.shift}`)}
              </td>
              <td
                className={`${CARD_TABLE.labelled} tabular-nums`}
                data-label={t('fleet.label.vehicles')}
              >
                {courier.activeVehicles}
              </td>
              <td className={CARD_TABLE.labelled} data-label={t('fleet.label.to-review')}>
                {courier.documentsToReview === 0 ? (
                  <span className="tabular-nums">0</span>
                ) : (
                  <Badge tone="attention">
                    {t('fleet.to-review', { count: courier.documentsToReview })}
                  </Badge>
                )}
              </td>
              <td className={CARD_TABLE.labelled} data-label={t('fleet.label.joined')}>
                {shortInstant(courier.createdAt, locale)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
