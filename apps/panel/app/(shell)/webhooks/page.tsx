import { LoadError } from '@mondapac-drive/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { namesFor } from '../../../src/deliveries/names.ts';
import { NoAccess } from '../../../src/ops/no-access.tsx';
import { NoticeProvider } from '../../../src/ops/notice.tsx';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../src/server/server-fetch.ts';
import { requireSession } from '../../../src/server/session.ts';
import { DeadCallsTable } from '../../../src/webhooks/dead-calls-table.tsx';
import { readSubscriptions } from '../../../src/webhooks/subscriptions.ts';
import { WEBHOOK_PERMISSION, type DeadWebhookCall } from '../../../src/webhooks/types.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('webhooks.title') };
}

/**
 * Webhook calls to merchants that every retry failed (dead-lettered), newest death first, with a
 * re-send each. The merchant of a call comes from the call, else from the subscriptions the
 * session may read.
 */
export default async function WebhooksPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const { session } = gate;
  const keys = new Set(session.permissionKeys);
  const title = t('webhooks.title');
  if (!keys.has(WEBHOOK_PERMISSION.callResend)) {
    return (
      <AdminShell session={session} activeId="webhooks" title={title}>
        <NoAccess scope="webhooks" />
      </AdminShell>
    );
  }
  const [dead, subscriptions, names] = await Promise.all([
    serverGet<{ readonly calls: readonly DeadWebhookCall[] }>(
      'notifications/admin/webhook-calls/dead',
    ),
    keys.has(WEBHOOK_PERMISSION.subscriptionView) ? readSubscriptions() : Promise.resolve(null),
    namesFor(keys),
  ]);
  if (dead.kind === 'signed-out') redirect('/session-ended');
  const merchantBySubscription = new Map(
    (subscriptions ?? []).map((row) => [row.id, row.merchantId] as const),
  );
  return (
    <AdminShell session={session} activeId="webhooks" title={title}>
      <div className="mb-4 flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="text-fg-muted">{t('webhooks.intro')}</p>
      </div>
      <NoticeProvider>
        {dead.kind === 'ok' ? (
          <DeadCallsTable
            calls={dead.body.calls}
            merchantBySubscription={merchantBySubscription}
            merchantNames={names.merchants}
            showMerchant
            canResend
            csrfToken={session.csrfToken}
          />
        ) : (
          <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />
        )}
      </NoticeProvider>
    </AdminShell>
  );
}
