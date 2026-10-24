import { CARD_TABLE, EmptyState } from '@mondapac-drive/ui';
import { getLocale, getTranslations } from 'next-intl/server';
import { ActionButton } from '../ops/action-button.tsx';
import type { ApiKey } from '../ops/types.ts';
import { formatInstant } from '../shared/format.ts';

/** A merchant's active API keys: label and dates only (the API never answers a key again). */
export async function KeysTable({
  merchantId,
  keys,
  csrfToken,
  canRevoke,
}: {
  readonly merchantId: string;
  readonly keys: readonly ApiKey[];
  readonly csrfToken: string;
  readonly canRevoke: boolean;
}) {
  const t = await getTranslations();
  const locale = await getLocale();
  if (keys.length === 0) {
    return <EmptyState icon="key" title={t('merchants.keys.empty')} size="compact" />;
  }
  return (
    <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
      <table className={CARD_TABLE.table}>
        <caption className="sr-only">{t('merchants.keys.table-caption')}</caption>
        <thead className={CARD_TABLE.head}>
          <tr>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('merchants.keys.label.label')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('merchants.keys.label.created')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('merchants.keys.label.last-seen')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('merchants.keys.label.expires')}
            </th>
            {canRevoke ? (
              <th scope="col" className="px-4 py-3 text-end font-medium">
                {t('merchants.label.actions')}
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody className={CARD_TABLE.body}>
          {keys.map((key) => (
            <tr key={key.keyId} className={CARD_TABLE.row}>
              <td className={`${CARD_TABLE.cell} break-words font-medium`}>{key.label}</td>
              <td className={CARD_TABLE.labelled} data-label={t('merchants.keys.label.created')}>
                {formatInstant(key.createdAt, locale)}
              </td>
              <td className={CARD_TABLE.labelled} data-label={t('merchants.keys.label.last-seen')}>
                {formatInstant(key.lastSeenAt, locale)}
              </td>
              <td className={CARD_TABLE.labelled} data-label={t('merchants.keys.label.expires')}>
                {formatInstant(key.expiresAt, locale)}
              </td>
              {canRevoke ? (
                <td className={`${CARD_TABLE.corner} text-end`}>
                  <ActionButton
                    label={t('merchants.keys.revoke.action')}
                    path={`identity/admin/merchants/${merchantId}/api-keys/${key.keyId}/revoke`}
                    csrfToken={csrfToken}
                    done={t('merchants.keys.revoke.done', { label: key.label })}
                    confirm={{
                      title: t('merchants.keys.revoke.title', { label: key.label }),
                      body: t('merchants.keys.revoke.body'),
                      action: t('merchants.keys.revoke.confirm'),
                      keep: t('ops.cancel'),
                    }}
                  />
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
