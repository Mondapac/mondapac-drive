import { Card, CARD_TABLE, DataList } from '@mondapac-drive/ui';
import { getLocale, getTranslations } from 'next-intl/server';
import { formatMoney } from '../ops/money.ts';
import type { Delivery, Stop } from '../ops/types.ts';
import { formatInstant } from '../shared/format.ts';
import { numberFormat } from '../shared/intl.ts';
import { shortId } from './names.ts';
import { DeliveryStatusBadge } from './status-badge.tsx';

type Translate = Awaited<ReturnType<typeof getTranslations>>;

function StopCard({
  t,
  title,
  stop,
}: {
  readonly t: Translate;
  readonly title: string;
  readonly stop: Stop;
}) {
  return (
    <Card title={title}>
      <DataList
        variant="stacked"
        missing="-"
        rows={[
          { label: t('deliveries.detail.address'), value: `${stop.address}, ${stop.postcode}` },
          {
            label: t('deliveries.detail.contact'),
            value: `${stop.contactName}, ${stop.contactPhone}`,
          },
          { label: t('deliveries.detail.notes'), value: stop.notes ?? null },
        ]}
      />
    </Card>
  );
}

/**
 * One delivery for an operator or dispatcher: status, stops (personal data of the recipient,
 * shown to holders of `delivery.delivery.view` only), parcel, price and the history, oldest
 * first. Free text (notes, reasons) is rendered as text, never as markup.
 */
export async function DeliveryDetail({
  delivery,
  merchantName,
  couriers,
}: {
  readonly delivery: Delivery;
  readonly merchantName: string | undefined;
  readonly couriers: ReadonlyMap<string, string>;
}) {
  const t = await getTranslations();
  const locale = await getLocale();
  const courierName = (id: string | undefined) =>
    id === undefined ? null : (couriers.get(id) ?? shortId(id));
  const { quote, parcel } = delivery;
  const kilograms = numberFormat(locale, { maximumFractionDigits: 1 }).format(
    parcel.weightGrams / 1000,
  );
  const km = numberFormat(locale, { maximumFractionDigits: 1 }).format(quote.distanceMetres / 1000);
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <DataList
          missing={t('deliveries.detail.no-courier')}
          rows={[
            {
              label: t('deliveries.label.status'),
              value: (
                <DeliveryStatusBadge
                  status={delivery.status}
                  label={t(`deliveries.status.${delivery.status}`)}
                />
              ),
            },
            {
              label: t('deliveries.label.merchant'),
              value: merchantName ?? shortId(delivery.merchantId),
            },
            { label: t('deliveries.label.courier'), value: courierName(delivery.courierId) },
            {
              label: t('deliveries.label.mode'),
              value: t(`deliveries.mode.${delivery.mode}`),
            },
            {
              label: t('deliveries.label.window'),
              value:
                delivery.window === undefined
                  ? '-'
                  : `${formatInstant(delivery.window.start, locale)} – ${formatInstant(delivery.window.end, locale)}`,
            },
            { label: t('deliveries.label.area'), value: delivery.serviceAreaCode },
            {
              label: t('deliveries.label.parcel'),
              value: t('deliveries.detail.parcel', {
                weight: kilograms,
                volume: parcel.volumeLitres,
                temperature: t(`deliveries.temperature.${parcel.temperature}`),
              }),
            },
            {
              label: t('deliveries.label.vehicle'),
              value: `${t(`deliveries.vehicle.${quote.vehicle}`)} · ${t('deliveries.detail.distance', { km })}`,
            },
            {
              label: t('deliveries.label.created'),
              value: formatInstant(delivery.createdAt, locale),
            },
          ]}
        />
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <StopCard t={t} title={t('deliveries.detail.pickup')} stop={delivery.pickup} />
        <StopCard t={t} title={t('deliveries.detail.dropoff')} stop={delivery.dropoff} />
      </div>
      <Card title={t('deliveries.detail.quote')}>
        <DataList
          variant="totals"
          missing="-"
          rows={[
            {
              label: t('deliveries.detail.breakdown.base'),
              value: formatMoney(quote.breakdown.base, locale),
            },
            {
              label: t('deliveries.detail.breakdown.distance'),
              value: formatMoney(quote.breakdown.distance, locale),
            },
            {
              label: t('deliveries.detail.breakdown.coldChain'),
              value: formatMoney(quote.breakdown.coldChain, locale),
            },
            {
              label: t('deliveries.detail.breakdown.scheduledDiscount'),
              value: formatMoney(quote.breakdown.scheduledDiscount, locale),
            },
            { label: t('deliveries.detail.breakdown.tax'), value: formatMoney(quote.tax, locale) },
            {
              label: t('deliveries.detail.breakdown.total'),
              value: formatMoney(quote.total, locale),
              emphasis: true,
            },
          ]}
        />
      </Card>
      <Card title={t('deliveries.detail.history')} flush>
        <div className="overflow-x-auto">
          <table className={CARD_TABLE.table}>
            <caption className="sr-only">{t('deliveries.detail.history-caption')}</caption>
            <thead className={CARD_TABLE.head}>
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">
                  {t('deliveries.detail.what')}
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  {t('deliveries.detail.at')}
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  {t('deliveries.detail.who')}
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  {t('deliveries.detail.reason')}
                </th>
              </tr>
            </thead>
            <tbody className={CARD_TABLE.body}>
              {delivery.history.map((entry, index) => (
                <tr key={`${entry.at}-${index}`} className={CARD_TABLE.row}>
                  <td className={`${CARD_TABLE.cell} font-medium`}>
                    {t.has(`deliveries.event.${entry.type}`)
                      ? t(`deliveries.event.${entry.type}`)
                      : t(`deliveries.status.${entry.status}`)}
                  </td>
                  <td className={CARD_TABLE.labelled} data-label={t('deliveries.detail.at')}>
                    {formatInstant(entry.at, locale)}
                  </td>
                  <td className={CARD_TABLE.labelled} data-label={t('deliveries.detail.who')}>
                    {courierName(entry.courierId) ?? '-'}
                    {entry.vehicle === undefined
                      ? null
                      : ` · ${t(`deliveries.vehicle.${entry.vehicle}`)}`}
                  </td>
                  <td className={CARD_TABLE.labelled} data-label={t('deliveries.detail.reason')}>
                    <span className="break-words">
                      {[
                        entry.temperatureCelsius === undefined
                          ? null
                          : `${numberFormat(locale, { maximumFractionDigits: 1 }).format(entry.temperatureCelsius)} °C`,
                        entry.proof === undefined
                          ? null
                          : t(
                              entry.proof.kind === 'pin'
                                ? 'deliveries.detail.proof-pin'
                                : 'deliveries.detail.proof-photo',
                            ),
                        entry.reason ?? null,
                      ]
                        .filter((part) => part !== null)
                        .join(' · ') || '-'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
