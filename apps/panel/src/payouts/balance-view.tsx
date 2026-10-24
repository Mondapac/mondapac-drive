import { Card, CARD_TABLE, EmptyState } from '@mondapac-drive/ui';
import { getLocale, getTranslations } from 'next-intl/server';
import { formatMoney } from '../ops/money.ts';
import { shortInstant } from '../shared/format.ts';
import type { CourierBalance } from './types.ts';

/** A courier's balance (before tax, tax, total) and the newest ledger entries. */
export async function BalanceView({ found }: { readonly found: CourierBalance }) {
  const t = await getTranslations();
  const locale = await getLocale();
  const { balance, entries } = found;
  return (
    <div className="flex flex-col gap-4">
      <Card title={t('payouts.balance.title')}>
        <dl className="grid gap-4 sm:grid-cols-3">
          {(['amount', 'tax', 'total'] as const).map((part) => (
            <div key={part} className="flex flex-col gap-1">
              <dt className="text-sm text-fg-muted">{t(`payouts.balance.${part}`)}</dt>
              <dd className="text-xl font-semibold tabular-nums">
                {formatMoney(balance[part], locale)}
              </dd>
            </div>
          ))}
        </dl>
      </Card>
      {entries.length === 0 ? (
        <EmptyState icon="receipt" title={t('payouts.entries.empty')} />
      ) : (
        <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
          <table className={CARD_TABLE.table}>
            <caption className="sr-only">{t('payouts.entries.caption')}</caption>
            <thead className={CARD_TABLE.head}>
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">
                  {t('payouts.entries.when')}
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  {t('payouts.entries.kind')}
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  {t('payouts.entries.amount')}
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  {t('payouts.entries.about')}
                </th>
              </tr>
            </thead>
            <tbody className={CARD_TABLE.body}>
              {entries.map((entry) => (
                <tr key={entry.id} className={CARD_TABLE.row}>
                  <td className={CARD_TABLE.cell}>{shortInstant(entry.occurredAt, locale)}</td>
                  <td className={CARD_TABLE.labelled} data-label={t('payouts.entries.kind')}>
                    {t(`payouts.kind.${entry.kind}`)}
                  </td>
                  <td
                    className={`${CARD_TABLE.labelled} tabular-nums`}
                    data-label={t('payouts.entries.amount')}
                  >
                    {formatMoney(entry.amount, locale)}
                    <div className="text-xs text-fg-muted">
                      {t('payouts.of-which-tax', { tax: formatMoney(entry.tax, locale) })}
                    </div>
                  </td>
                  <td className={CARD_TABLE.labelled} data-label={t('payouts.entries.about')}>
                    {entry.deliveryId === undefined ? null : (
                      <a
                        className="inline-flex min-h-12 items-center font-medium text-link underline"
                        href={`/deliveries/${entry.deliveryId}`}
                      >
                        {t('payouts.entries.delivery')}
                      </a>
                    )}
                    {entry.reason === undefined ? null : (
                      <div className="text-sm text-fg-muted">
                        {t.has(`payouts.reason.${entry.reason}`)
                          ? t(`payouts.reason.${entry.reason}`)
                          : entry.reason}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
