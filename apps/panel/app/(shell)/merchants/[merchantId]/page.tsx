import { Banner, BackLink, LoadError } from '@mondapac-drive/ui';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { IssueKeyButton } from '../../../../src/merchants/issue-key-button.tsx';
import { KeysTable } from '../../../../src/merchants/keys-table.tsx';
import { NoAccess } from '../../../../src/ops/no-access.tsx';
import { NoticeProvider } from '../../../../src/ops/notice.tsx';
import { PERMISSION, UUID, type ApiKey, type Merchant } from '../../../../src/ops/types.ts';
import { AdminShell } from '../../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('merchants.title') };
}

export default async function MerchantKeysPage({
  params,
}: {
  readonly params: Promise<{ readonly merchantId: string }>;
}) {
  const { merchantId } = await params;
  if (!UUID.test(merchantId)) notFound();
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const { session } = gate;
  const keys = new Set(session.permissionKeys);
  if (!keys.has(PERMISSION.merchantView)) {
    return (
      <AdminShell session={session} activeId="merchants" title={t('merchants.title')}>
        <NoAccess scope="merchants" />
      </AdminShell>
    );
  }
  const [merchants, apiKeys] = await Promise.all([
    serverGet<{ readonly items: readonly Merchant[] }>('identity/admin/merchants'),
    serverGet<{ readonly items: readonly ApiKey[] }>(
      `identity/admin/merchants/${merchantId}/api-keys`,
    ),
  ]);
  if (merchants.kind === 'signed-out' || apiKeys.kind === 'signed-out') {
    redirect('/session-ended');
  }
  if (apiKeys.kind === 'not-found') notFound();
  const merchant =
    merchants.kind === 'ok'
      ? merchants.body.items.find((row) => row.merchantId === merchantId)
      : undefined;
  if (merchants.kind === 'ok' && merchant === undefined) notFound();
  const title = t('merchants.keys.title', { name: merchant?.name ?? '' });
  const canIssue = keys.has(PERMISSION.apiKeyIssue);
  return (
    <AdminShell session={session} activeId="merchants" title={title}>
      <BackLink href="/merchants" label={t('merchants.back')} />
      <NoticeProvider>
        <div className="mb-4 mt-2 flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="break-words text-2xl font-semibold">{title}</h1>
            <p className="text-fg-muted">{t('merchants.keys.intro')}</p>
          </div>
          {canIssue && merchant?.state === 'active' ? (
            <IssueKeyButton merchantId={merchantId} csrfToken={session.csrfToken} />
          ) : null}
        </div>
        {canIssue && merchant?.state === 'suspended' ? (
          <div className="mb-4">
            <Banner tone="attention">{t('merchants.keys.suspended')}</Banner>
          </div>
        ) : null}
        {apiKeys.kind === 'ok' && merchant !== undefined ? (
          <KeysTable
            merchantId={merchantId}
            keys={apiKeys.body.items}
            csrfToken={session.csrfToken}
            canRevoke={canIssue}
          />
        ) : (
          <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />
        )}
      </NoticeProvider>
    </AdminShell>
  );
}
