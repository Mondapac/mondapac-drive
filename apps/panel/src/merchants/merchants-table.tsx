import { Badge, CARD_TABLE, EmptyState, LinkButton } from '@mondapac-drive/ui';
import { getLocale, getTranslations } from 'next-intl/server';
import { ActionButton } from '../ops/action-button.tsx';
import type { Merchant } from '../ops/types.ts';
import { formatInstant } from '../shared/format.ts';

/** The merchants of the Market with their state, a link to their keys, and suspend/reinstate. */
export async function MerchantsTable({
  merchants,
  csrfToken,
  canSuspend,
}: {
  readonly merchants: readonly Merchant[];
  readonly csrfToken: string;
  readonly canSuspend: boolean;
}) {
  const t = await getTranslations();
  const locale = await getLocale();
  if (merchants.length === 0) {
    return (
      <EmptyState
        icon="store"
        title={t('merchants.empty.title')}
        body={t('merchants.empty.body')}
      />
    );
  }
  return (
    <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
      <table className={CARD_TABLE.table}>
        <caption className="sr-only">{t('merchants.table-caption')}</caption>
        <thead className={CARD_TABLE.head}>
          <tr>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('merchants.label.name')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('merchants.label.state')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('merchants.label.created')}
            </th>
            <th scope="col" className="px-4 py-3 text-end font-medium">
              {t('merchants.label.actions')}
            </th>
          </tr>
        </thead>
        <tbody className={CARD_TABLE.body}>
          {merchants.map((merchant) => (
            <tr key={merchant.merchantId} className={CARD_TABLE.row}>
              <td className={`${CARD_TABLE.cell} break-words font-medium`}>{merchant.name}</td>
              <td className={CARD_TABLE.labelled} data-label={t('merchants.label.state')}>
                <Badge tone={merchant.state === 'active' ? 'success' : 'attention'}>
                  {t(`merchants.state.${merchant.state}`)}
                </Badge>
              </td>
              <td className={CARD_TABLE.labelled} data-label={t('merchants.label.created')}>
                {formatInstant(merchant.createdAt, locale)}
              </td>
              <td
                className={`${CARD_TABLE.labelled} lg:text-end`}
                data-label={t('merchants.label.actions')}
              >
                <span className="inline-flex flex-wrap justify-end gap-2">
                  <LinkButton variant="secondary" href={`/merchants/${merchant.merchantId}`}>
                    {t('merchants.action.keys')}
                  </LinkButton>
                  {!canSuspend ? null : merchant.state === 'active' ? (
                    <ActionButton
                      label={t('merchants.action.suspend')}
                      path={`identity/admin/merchants/${merchant.merchantId}/suspend`}
                      csrfToken={csrfToken}
                      done={t('merchants.suspend.done', { name: merchant.name })}
                      confirm={{
                        title: t('merchants.suspend.title', { name: merchant.name }),
                        body: t('merchants.suspend.body'),
                        action: t('merchants.suspend.action'),
                        keep: t('ops.cancel'),
                      }}
                    />
                  ) : (
                    <ActionButton
                      label={t('merchants.action.reinstate')}
                      path={`identity/admin/merchants/${merchant.merchantId}/reinstate`}
                      csrfToken={csrfToken}
                      done={t('merchants.reinstated', { name: merchant.name })}
                    />
                  )}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
