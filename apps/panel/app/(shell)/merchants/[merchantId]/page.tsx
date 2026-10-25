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
import { DeadCallsTable, merchantOfCall } from '../../../../src/webhooks/dead-calls-table.tsx';
import { SubscriptionsTable } from '../../../../src/webhooks/subscriptions-table.tsx';
import { readSubscriptions } from '../../../../src/webhooks/subscriptions.ts';
import { WEBHOOK_PERMISSION, type DeadWebhookCall } from '../../../../src/webhooks/types.ts';

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
  const seesSubscriptions = keys.has(WEBHOOK_PERMISSION.subscriptionView);
  const seesDeadCalls = keys.has(WEBHOOK_PERMISSION.callResend);
  const [merchants, apiKeys, subscriptions, dead] = await Promise.all([
    serverGet<{ readonly items: readonly Merchant[] }>('identity/admin/merchants'),
    serverGet<{ readonly items: readonly ApiKey[] }>(
      `identity/admin/merchants/${merchantId}/api-keys`,
    ),
    seesSubscriptions ? readSubscriptions(merchantId) : Promise.resolve(null),
    seesDeadCalls
      ? serverGet<{ readonly calls: readonly DeadWebhookCall[] }>(
          'notifications/admin/webhook-calls/dead',
        )
      : Promise.resolve(null),
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
  // The merchant's dead calls: by the call's own merchant, else through its subscriptions.
  const merchantBySubscription = new Map(
    (subscriptions ?? []).map((row) => [row.id, row.merchantId] as const),
  );
  const merchantDead =
    dead?.kind === 'ok'
      ? dead.body.calls.filter(
          (call) => merchantOfCall(call, merchantBySubscription) === merchantId,
        )
      : null;
  return (
    <AdminShell session={session} activeId="merchants" title={title}>
      <BackLink href="/merchants" label={t('merchants.back')} />
      <NoticeProvider>
        <div className="mb-4 mt-2 flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="break-words text-2xl font-semibold">{title}</h1>
            <p className="text-fg-muted">{t('merchants.keys.intro')}</p>
            {keys.has(PERMISSION.deliveryView) ? (
              <a
                className="inline-flex min-h-12 items-center font-medium text-link underline"
                href={`/deliveries?merchant=${merchantId}`}
              >
                {t('merchants.deliveries-link')}
              </a>
            ) : null}
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
        {seesSubscriptions ? (
          <section aria-labelledby="merchant-webhooks" className="mt-8 flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <h2 id="merchant-webhooks" className="text-lg font-semibold">
                {t('webhooks.subscriptions.title')}
              </h2>
              <p className="text-fg-muted">{t('webhooks.subscriptions.intro')}</p>
            </div>
            {subscriptions === null ? (
              <LoadError
                message={t('webhooks.subscriptions.unavailable')}
                retryLabel={t('load.retry')}
              />
            ) : (
              <SubscriptionsTable subscriptions={subscriptions} />
            )}
          </section>
        ) : null}
        {seesDeadCalls ? (
          <section aria-labelledby="merchant-dead-calls" className="mt-8 flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <h2 id="merchant-dead-calls" className="text-lg font-semibold">
                {t('webhooks.dead.merchant-title')}
              </h2>
              <p className="text-fg-muted">{t('webhooks.dead.merchant-intro')}</p>
            </div>
            {merchantDead === null ? (
              <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />
            ) : (
              <DeadCallsTable
                calls={merchantDead}
                merchantBySubscription={merchantBySubscription}
                merchantNames={new Map()}
                showMerchant={false}
                canResend
                csrfToken={session.csrfToken}
              />
            )}
          </section>
        ) : null}
      </NoticeProvider>
    </AdminShell>
  );
}
