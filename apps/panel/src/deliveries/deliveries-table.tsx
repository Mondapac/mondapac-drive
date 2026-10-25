import { Badge, CARD_TABLE, EmptyState } from '@mondapac-drive/ui';
import { getLocale, getTranslations } from 'next-intl/server';
import { formatMoney } from '../ops/money.ts';
import type { DeliverySummary } from '../ops/types.ts';
import { shortInstant } from '../shared/format.ts';
import { shortId } from './names.ts';
import { DeliveryStatusBadge } from './status-badge.tsx';

/** The delivery list: one row per delivery, its reference linking to the detail. */
export async function DeliveriesTable({
  items,
  merchants,
  couriers,
}: {
  readonly items: readonly DeliverySummary[];
  readonly merchants: ReadonlyMap<string, string>;
  readonly couriers: ReadonlyMap<string, string>;
}) {
  const t = await getTranslations();
  const locale = await getLocale();
  if (items.length === 0) {
    return (
      <EmptyState
        icon="package"
        title={t('deliveries.empty.title')}
        body={t('deliveries.empty.body')}
      />
    );
  }
  return (
    <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
      <table className={CARD_TABLE.table}>
        <caption className="sr-only">{t('deliveries.table-caption')}</caption>
        <thead className={CARD_TABLE.head}>
          <tr>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('deliveries.label.reference')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('deliveries.label.status')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('deliveries.label.merchant')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('deliveries.label.route')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('deliveries.label.courier')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('deliveries.label.total')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('deliveries.label.created')}
            </th>
          </tr>
        </thead>
        <tbody className={CARD_TABLE.body}>
          {items.map((row) => (
            <tr key={row.id} className={CARD_TABLE.row}>
              <td className={CARD_TABLE.cell}>
                <a
                  className="inline-flex min-h-12 items-center break-all font-medium text-link underline"
                  href={`/deliveries/${row.id}`}
                >
                  {row.externalReference}
                </a>
                <div className="text-xs text-fg-muted">
                  {t(`deliveries.mode.${row.mode}`)} · {t(`deliveries.vehicle.${row.vehicle}`)} ·{' '}
                  {t(`deliveries.temperature.${row.temperature}`)}
                </div>
              </td>
              <td className={CARD_TABLE.corner}>
                <div className="flex flex-col items-start gap-1">
                  <DeliveryStatusBadge
                    status={row.status}
                    label={t(`deliveries.status.${row.status}`)}
                  />
                  {row.exception == null ? null : (
                    <Badge tone="critical">{t(`deliveries.exception.${row.exception}`)}</Badge>
                  )}
                </div>
              </td>
              <td className={CARD_TABLE.labelled} data-label={t('deliveries.label.merchant')}>
                <span className="break-words">
                  {merchants.get(row.merchantId) ?? shortId(row.merchantId)}
                </span>
              </td>
              <td className={CARD_TABLE.labelled} data-label={t('deliveries.label.route')}>
                {t('deliveries.route', { from: row.pickupPostcode, to: row.dropoffPostcode })}
              </td>
              <td className={CARD_TABLE.labelled} data-label={t('deliveries.label.courier')}>
                {row.courierId === undefined ? (
                  <span className="text-fg-muted">{t('deliveries.detail.no-courier')}</span>
                ) : (
                  <span className="break-words">
                    {couriers.get(row.courierId) ?? shortId(row.courierId)}
                  </span>
                )}
              </td>
              <td
                className={`${CARD_TABLE.labelled} tabular-nums`}
                data-label={t('deliveries.label.total')}
              >
                {formatMoney(row.total, locale)}
              </td>
              <td className={CARD_TABLE.labelled} data-label={t('deliveries.label.created')}>
                {shortInstant(row.createdAt, locale)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
