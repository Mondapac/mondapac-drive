import { Badge, CARD_TABLE, EmailText, EmptyState, type BadgeTone } from '@mondapac-drive/ui';
import { getTranslations } from 'next-intl/server';
import { ActionButton } from '../ops/action-button.tsx';
import { rowName } from '../ops/row-name.ts';
import type { CourierPage, CourierRow } from '../ops/types.ts';

const TONE: Readonly<Record<CourierRow['status'], BadgeTone>> = {
  active: 'success',
  disabled: 'neutral',
  pending: 'info',
  expired: 'attention',
};

/** Courier accounts and pending invitations, with disable/enable for a holder of the key. */
export async function CouriersTable({
  page,
  after,
  csrfToken,
  canDisable,
}: {
  readonly page: CourierPage;
  readonly after: string | null;
  readonly csrfToken: string;
  readonly canDisable: boolean;
}) {
  const t = await getTranslations();
  if (page.items.length === 0 && after === null) {
    return (
      <EmptyState icon="users" title={t('couriers.empty.title')} body={t('couriers.empty.body')} />
    );
  }
  if (page.items.length === 0) {
    return <p className="text-fg-muted">{t('identity.members.empty.page')}</p>;
  }
  return (
    <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
      <table className={CARD_TABLE.table}>
        <caption className="sr-only">{t('couriers.table-caption')}</caption>
        <thead className={CARD_TABLE.head}>
          <tr>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('couriers.label.person')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('couriers.label.status')}
            </th>
            {canDisable ? (
              <th scope="col" className="px-4 py-3 text-end font-medium">
                {t('couriers.label.actions')}
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody className={CARD_TABLE.body}>
          {page.items.map((row) => {
            const id = row.type === 'account' ? row.accountId : row.invitationId;
            const name = row.type === 'account' ? row.displayName : null;
            return (
              <tr key={`${row.type}-${id}`} className={CARD_TABLE.row}>
                <td className={CARD_TABLE.cell}>
                  <div className="min-w-0">
                    <div className="break-words font-medium">
                      {name ?? <EmailText address={row.email} />}
                    </div>
                    {name === null ? null : (
                      <div className="break-words text-sm text-fg-muted">
                        <EmailText address={row.email} />
                      </div>
                    )}
                  </div>
                </td>
                <td className={CARD_TABLE.labelled} data-label={t('couriers.label.status')}>
                  <Badge tone={TONE[row.status]}>{t(`couriers.status.${row.status}`)}</Badge>
                </td>
                {canDisable ? (
                  <td className={`${CARD_TABLE.corner} text-end`}>
                    {row.type !== 'account' ? null : row.status === 'active' ? (
                      <ActionButton
                        label={t('couriers.action.disable')}
                        name={rowName(t, t('couriers.action.disable'), name ?? row.email)}
                        path={`identity/admin/couriers/${row.accountId}/disable`}
                        csrfToken={csrfToken}
                        done={t('couriers.disable.done', { name: name ?? row.email })}
                        confirm={{
                          title: t('couriers.disable.title', { name: name ?? row.email }),
                          body: t('couriers.disable.body'),
                          action: t('couriers.disable.action'),
                          keep: t('ops.cancel'),
                        }}
                      />
                    ) : (
                      <ActionButton
                        label={t('couriers.action.enable')}
                        name={rowName(t, t('couriers.action.enable'), name ?? row.email)}
                        path={`identity/admin/couriers/${row.accountId}/enable`}
                        csrfToken={csrfToken}
                        done={t('couriers.enabled', { name: name ?? row.email })}
                      />
                    )}
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
