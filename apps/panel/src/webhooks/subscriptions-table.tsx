import { Badge, CARD_TABLE, EmptyState } from '@mondapac-drive/ui';
import { getLocale, getTranslations } from 'next-intl/server';
import { formatInstant, shortInstant } from '../shared/format.ts';
import type { WebhookSubscription } from './types.ts';

/**
 * A merchant's webhook subscriptions as support sees them: the endpoint, the events it hears,
 * whether it is active and which secret signs it. Never the secret itself.
 */
export async function SubscriptionsTable({
  subscriptions,
}: {
  readonly subscriptions: readonly WebhookSubscription[];
}) {
  const t = await getTranslations('webhooks');
  const locale = await getLocale();
  if (subscriptions.length === 0) {
    return (
      <EmptyState
        icon="bell"
        title={t('subscriptions.empty.title')}
        body={t('subscriptions.empty.body')}
        size="compact"
      />
    );
  }
  return (
    <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
      <table className={CARD_TABLE.table}>
        <caption className="sr-only">{t('subscriptions.caption')}</caption>
        <thead className={CARD_TABLE.head}>
          <tr>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('label.endpoint')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('label.status')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('label.events')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('label.secret')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('label.created')}
            </th>
          </tr>
        </thead>
        <tbody className={CARD_TABLE.body}>
          {subscriptions.map((row) => (
            <tr key={row.id} className={CARD_TABLE.row}>
              <td className={CARD_TABLE.cell}>
                {/* Text, never a link: the panel does not send operators to a merchant's URL. */}
                <span className="break-all font-medium">{row.url}</span>
              </td>
              <td className={CARD_TABLE.corner}>
                <Badge tone={row.status === 'active' ? 'success' : 'neutral'}>
                  {t.has(`status.${row.status}`) ? t(`status.${row.status}`) : row.status}
                </Badge>
              </td>
              <td className={CARD_TABLE.labelled} data-label={t('label.events')}>
                <span className="break-words">{row.eventTypes.join(', ')}</span>
              </td>
              <td className={CARD_TABLE.labelled} data-label={t('label.secret')}>
                {row.previousSecretValidUntil === null
                  ? t('secret.version', { version: row.secretVersion })
                  : t('secret.rotating', {
                      version: row.secretVersion,
                      until: formatInstant(row.previousSecretValidUntil, locale),
                    })}
              </td>
              <td className={CARD_TABLE.labelled} data-label={t('label.created')}>
                {shortInstant(row.createdAt, locale)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
