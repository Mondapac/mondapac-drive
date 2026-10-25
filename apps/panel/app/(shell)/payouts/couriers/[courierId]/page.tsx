import { BackLink, LoadError } from '@mondapac-drive/ui';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { namesFor } from '../../../../../src/deliveries/names.ts';
import { fleetIdsByAccount } from '../../../../../src/fleet/fleet-ids.ts';
import { CourierLinks } from '../../../../../src/ops/courier-links.tsx';
import { NoAccess } from '../../../../../src/ops/no-access.tsx';
import { NoticeProvider } from '../../../../../src/ops/notice.tsx';
import { UUID } from '../../../../../src/ops/types.ts';
import { AdjustmentButton } from '../../../../../src/payouts/adjustment-button.tsx';
import { BalanceView } from '../../../../../src/payouts/balance-view.tsx';
import { PAYOUT_PERMISSION, type CourierBalance } from '../../../../../src/payouts/types.ts';
import { shortId } from '../../../../../src/shared/short-id.ts';
import { AdminShell } from '../../../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../../src/server/session.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('payouts.title') };
}

/** One courier's balance and ledger, and the adjustment tool (protected key). */
export default async function CourierPayoutsPage({
  params,
}: {
  readonly params: Promise<{ readonly courierId: string }>;
}) {
  const { courierId } = await params;
  if (!UUID.test(courierId)) notFound();
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const { session } = gate;
  const keys = new Set(session.permissionKeys);
  if (!keys.has(PAYOUT_PERMISSION.ledgerView)) {
    return (
      <AdminShell session={session} activeId="payouts" title={t('payouts.title')}>
        <NoAccess scope="payouts" />
      </AdminShell>
    );
  }
  const [result, names, fleetIds] = await Promise.all([
    serverGet<CourierBalance>(`payouts/admin/couriers/${courierId}/balance?limit=100`),
    namesFor(keys),
    fleetIdsByAccount(keys),
  ]);
  if (result.kind === 'signed-out') redirect('/session-ended');
  if (result.kind === 'not-found') notFound();
  const name = names.couriers.get(courierId) ?? shortId(courierId);
  const title = t('payouts.courier.title', { name });
  return (
    <AdminShell session={session} activeId="payouts" title={title}>
      <BackLink href="/payouts" label={t('payouts.back')} />
      <NoticeProvider>
        <div className="mb-4 mt-2 flex flex-wrap items-end justify-between gap-4">
          <h1 className="break-words text-2xl font-semibold">{title}</h1>
          {result.kind === 'ok' && keys.has(PAYOUT_PERMISSION.adjustmentRecord) ? (
            <AdjustmentButton
              courierId={courierId}
              currency={result.body.balance.total.currency}
              csrfToken={session.csrfToken}
            />
          ) : null}
        </div>
        <div className="mb-4">
          <CourierLinks
            accountId={courierId}
            fleetId={fleetIds.get(courierId) ?? null}
            keys={keys}
            current="payouts"
          />
        </div>
        {result.kind === 'ok' ? (
          <BalanceView found={result.body} />
        ) : (
          <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />
        )}
      </NoticeProvider>
    </AdminShell>
  );
}
