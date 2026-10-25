import { Badge, CARD_TABLE, EmptyState } from '@mondapac-drive/ui';
import { getLocale, getTranslations } from 'next-intl/server';
import { shortInstant } from '../shared/format.ts';
import { shortId } from '../shared/short-id.ts';
import type { ExpiringDocument } from './types.ts';

/** Verified documents expiring soon (or expired), each linking to its courier's fleet page. */
export async function ExpiringTable({
  documents,
  couriers,
  firstPage,
  now,
}: {
  readonly documents: readonly ExpiringDocument[];
  /** Courier names by identity account id; a missing name shows the fleet short id. */
  readonly couriers: ReadonlyMap<string, string>;
  readonly firstPage: boolean;
  readonly now: Date;
}) {
  const t = await getTranslations();
  const locale = await getLocale();
  if (documents.length === 0) {
    return firstPage ? (
      <EmptyState
        icon="file-text"
        title={t('fleet.expiring.empty-title')}
        body={t('fleet.expiring.empty-body')}
      />
    ) : (
      <p className="text-fg-muted">{t('fleet.empty.page')}</p>
    );
  }
  const documentName = (type: string) =>
    t.has(`fleet.document-type.${type}`) ? t(`fleet.document-type.${type}`) : type;
  return (
    <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
      <table className={CARD_TABLE.table}>
        <caption className="sr-only">{t('fleet.expiring.caption')}</caption>
        <thead className={CARD_TABLE.head}>
          <tr>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('fleet.expiring.document')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('fleet.expiring.courier')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('fleet.expiring.expires')}
            </th>
          </tr>
        </thead>
        <tbody className={CARD_TABLE.body}>
          {documents.map((document) => {
            const expired = new Date(document.expiresAt).getTime() <= now.getTime();
            return (
              <tr key={document.documentId} className={CARD_TABLE.row}>
                <td className={CARD_TABLE.cell}>
                  <div className="break-words font-medium">{documentName(document.type)}</div>
                </td>
                <td className={CARD_TABLE.labelled} data-label={t('fleet.expiring.courier')}>
                  <a
                    className="inline-flex min-h-12 items-center break-words font-medium text-link underline"
                    href={`/fleet/couriers/${document.courierId}`}
                  >
                    {couriers.get(document.accountId) ??
                      t('fleet.courier-ref', { id: shortId(document.courierId) })}
                  </a>
                </td>
                <td className={CARD_TABLE.labelled} data-label={t('fleet.expiring.expires')}>
                  <span className="tabular-nums">{shortInstant(document.expiresAt, locale)}</span>
                  {expired ? <Badge tone="critical">{t('fleet.expiring.expired')}</Badge> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
