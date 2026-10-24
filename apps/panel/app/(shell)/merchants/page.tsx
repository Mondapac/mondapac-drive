import { LoadError } from '@mondapac-drive/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AddMerchantButton } from '../../../src/merchants/add-merchant-button.tsx';
import { MerchantsTable } from '../../../src/merchants/merchants-table.tsx';
import { NoAccess } from '../../../src/ops/no-access.tsx';
import { NoticeProvider } from '../../../src/ops/notice.tsx';
import { PERMISSION, type Merchant } from '../../../src/ops/types.ts';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../src/server/server-fetch.ts';
import { requireSession } from '../../../src/server/session.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('merchants.title') };
}

export default async function MerchantsPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const { session } = gate;
  const keys = new Set(session.permissionKeys);
  const title = t('merchants.title');
  if (!keys.has(PERMISSION.merchantView)) {
    return (
      <AdminShell session={session} activeId="home" title={title}>
        <NoAccess scope="merchants" />
      </AdminShell>
    );
  }
  const result = await serverGet<{ readonly items: readonly Merchant[] }>(
    'identity/admin/merchants',
  );
  if (result.kind === 'signed-out') redirect('/session-ended');
  return (
    <AdminShell session={session} activeId="merchants" title={title}>
      <NoticeProvider>
        <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold">{title}</h1>
            <p className="text-fg-muted">{t('merchants.intro')}</p>
          </div>
          {keys.has(PERMISSION.merchantCreate) ? (
            <AddMerchantButton csrfToken={session.csrfToken} />
          ) : null}
        </div>
        {result.kind === 'ok' ? (
          <MerchantsTable
            merchants={result.body.items}
            csrfToken={session.csrfToken}
            canSuspend={keys.has(PERMISSION.merchantSuspend)}
          />
        ) : (
          <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />
        )}
      </NoticeProvider>
    </AdminShell>
  );
}
