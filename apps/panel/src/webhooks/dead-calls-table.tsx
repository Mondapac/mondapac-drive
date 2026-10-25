import { CARD_TABLE, EmptyState } from '@mondapac-drive/ui';
import { getLocale, getTranslations } from 'next-intl/server';
import { ActionButton } from '../ops/action-button.tsx';
import { shortInstant } from '../shared/format.ts';
import { shortId } from '../shared/short-id.ts';
import type { DeadWebhookCall } from './types.ts';

/** The merchant of a dead call: its own field, else its subscription's merchant. */
export function merchantOfCall(
  call: DeadWebhookCall,
  merchantBySubscription: ReadonlyMap<string, string>,
): string | undefined {
  return call.merchantId ?? merchantBySubscription.get(call.subscriptionId);
}

/**
 * Dead-lettered webhook calls: the event, the merchant, how often it was tried, the endpoint's
 * last answer and when it died, with a re-send for holders of
 * `notifications.webhook-call.resend`. Codes and times only, never the body.
 */
export async function DeadCallsTable({
  calls,
  merchantBySubscription,
  merchantNames,
  showMerchant,
  canResend,
  csrfToken,
}: {
  readonly calls: readonly DeadWebhookCall[];
  /** Subscription id to merchant id, from the subscriptions the session may read. */
  readonly merchantBySubscription: ReadonlyMap<string, string>;
  readonly merchantNames: ReadonlyMap<string, string>;
  readonly showMerchant: boolean;
  readonly canResend: boolean;
  readonly csrfToken: string;
}) {
  const t = await getTranslations('webhooks');
  const locale = await getLocale();
  if (calls.length === 0) {
    return (
      <EmptyState
        icon="check"
        title={t('dead.empty.title')}
        body={t('dead.empty.body')}
        size="compact"
      />
    );
  }
  return (
    <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
      <table className={CARD_TABLE.table}>
        <caption className="sr-only">{t('dead.caption')}</caption>
        <thead className={CARD_TABLE.head}>
          <tr>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('label.event')}
            </th>
            {showMerchant ? (
              <th scope="col" className="px-4 py-3 font-medium">
                {t('label.merchant')}
              </th>
            ) : null}
            <th scope="col" className="px-4 py-3 font-medium">
              {t('label.last-answer')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('label.attempts')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('label.dead-at')}
            </th>
            {canResend ? (
              <th scope="col" className="px-4 py-3 font-medium">
                <span className="sr-only">{t('label.actions')}</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody className={CARD_TABLE.body}>
          {calls.map((call) => {
            const merchantId = merchantOfCall(call, merchantBySubscription);
            return (
              <tr key={call.id} className={CARD_TABLE.row}>
                <td className={CARD_TABLE.cell}>
                  <span className="break-all font-medium">{call.eventType}</span>
                  <div className="text-xs text-fg-muted">
                    {t('event-id', { id: shortId(call.eventId) })}
                  </div>
                </td>
                {showMerchant ? (
                  <td className={CARD_TABLE.labelled} data-label={t('label.merchant')}>
                    {merchantId === undefined ? (
                      <span className="text-fg-muted">
                        {t('subscription-id', { id: shortId(call.subscriptionId) })}
                      </span>
                    ) : (
                      <a
                        className="inline-flex min-h-12 items-center break-words font-medium text-link underline"
                        href={`/merchants/${merchantId}`}
                      >
                        {merchantNames.get(merchantId) ?? shortId(merchantId)}
                      </a>
                    )}
                  </td>
                ) : null}
                <td className={CARD_TABLE.labelled} data-label={t('label.last-answer')}>
                  {call.lastStatusCode !== null
                    ? t('answer.http', { code: call.lastStatusCode })
                    : call.lastErrorCode !== null
                      ? t.has(`answer.error.${call.lastErrorCode}`)
                        ? t(`answer.error.${call.lastErrorCode}`)
                        : call.lastErrorCode
                      : t('answer.none')}
                </td>
                <td
                  className={`${CARD_TABLE.labelled} tabular-nums`}
                  data-label={t('label.attempts')}
                >
                  {call.attempts}
                </td>
                <td className={CARD_TABLE.labelled} data-label={t('label.dead-at')}>
                  {shortInstant(call.deadAt, locale)}
                </td>
                {canResend ? (
                  <td className={CARD_TABLE.labelled} data-label={t('label.actions')}>
                    <ActionButton
                      label={t('resend.button')}
                      path={`notifications/admin/webhook-calls/${call.id}/resend`}
                      csrfToken={csrfToken}
                      done={t('resend.done', { event: call.eventType })}
                      errorScope="webhooks"
                    />
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
