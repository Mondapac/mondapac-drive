import { Badge, CARD_TABLE, EmptyState, type BadgeTone } from '@mondapac-drive/ui';
import { getLocale, getTranslations } from 'next-intl/server';
import { ActionButton } from '../ops/action-button.tsx';
import { formatMoney } from '../ops/money.ts';
import { shortInstant } from '../shared/format.ts';
import { shortId } from '../shared/short-id.ts';
import type { LineStatus, PayoutLine } from './types.ts';

const TONE: Readonly<Record<LineStatus, BadgeTone>> = {
  pending: 'neutral',
  held: 'attention',
  transferred: 'success',
  failed: 'critical',
  unresolved: 'critical',
  reversed: 'neutral',
};

/**
 * Payout lines: courier, amount with its tax, status with the hold reason or the last provider
 * error, and the settle tool on an unresolved line (protected key, audited by the API).
 */
export async function LinesTable({
  lines,
  couriers,
  canSettle,
  csrfToken,
}: {
  readonly lines: readonly PayoutLine[];
  readonly couriers: ReadonlyMap<string, string>;
  readonly canSettle: boolean;
  readonly csrfToken: string;
}) {
  const t = await getTranslations();
  const locale = await getLocale();
  if (lines.length === 0) {
    return (
      <EmptyState icon="wallet" title={t('payouts.empty.title')} body={t('payouts.empty.body')} />
    );
  }
  return (
    <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
      <table className={CARD_TABLE.table}>
        <caption className="sr-only">{t('payouts.table-caption')}</caption>
        <thead className={CARD_TABLE.head}>
          <tr>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('payouts.label.courier')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('payouts.label.status')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('payouts.label.amount')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('payouts.label.attempts')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('payouts.label.created')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              <span className="sr-only">{t('payouts.label.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody className={CARD_TABLE.body}>
          {lines.map((line) => (
            <tr key={line.id} className={CARD_TABLE.row}>
              <td className={CARD_TABLE.cell}>
                <a
                  className="inline-flex min-h-12 items-center break-words font-medium text-link underline"
                  href={`/payouts/couriers/${line.courierId}`}
                >
                  {couriers.get(line.courierId) ?? shortId(line.courierId)}
                </a>
                <div className="text-xs text-fg-muted">
                  {t('payouts.line-ref', { id: shortId(line.id) })}
                </div>
              </td>
              <td className={CARD_TABLE.corner}>
                <Badge tone={TONE[line.status]}>{t(`payouts.status.${line.status}`)}</Badge>
              </td>
              <td
                className={`${CARD_TABLE.labelled} tabular-nums`}
                data-label={t('payouts.label.amount')}
              >
                {formatMoney(line.amount, locale)}
                <div className="text-xs text-fg-muted">
                  {t('payouts.of-which-tax', { tax: formatMoney(line.tax, locale) })}
                </div>
              </td>
              <td className={CARD_TABLE.labelled} data-label={t('payouts.label.attempts')}>
                {line.attempts}
                {line.holdReason === undefined ? null : (
                  <div className="text-xs text-fg-muted">
                    {t.has(`payouts.hold.${line.holdReason}`)
                      ? t(`payouts.hold.${line.holdReason}`)
                      : line.holdReason}
                  </div>
                )}
                {line.lastErrorCode === undefined ? null : (
                  <div className="break-all text-xs text-fg-muted">
                    {t('payouts.last-error', { code: line.lastErrorCode })}
                  </div>
                )}
              </td>
              <td className={CARD_TABLE.labelled} data-label={t('payouts.label.created')}>
                {shortInstant(line.createdAt, locale)}
              </td>
              <td className={CARD_TABLE.labelled} data-label={t('payouts.label.actions')}>
                {canSettle && line.status === 'unresolved' ? (
                  <ActionButton
                    label={t('payouts.settle.button')}
                    path={`payouts/admin/lines/${line.id}/settle`}
                    csrfToken={csrfToken}
                    done={t('payouts.settle.done')}
                    errorScope="payouts"
                    confirm={{
                      title: t('payouts.settle.title'),
                      body: t('payouts.settle.body', {
                        amount: formatMoney(line.amount, locale),
                      }),
                      action: t('payouts.settle.action'),
                      keep: t('ops.cancel'),
                    }}
                  />
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
