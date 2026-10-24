import { BackLink, LoadError } from '@mondapac-drive/ui';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { DeliveryDetail } from '../../../../src/deliveries/delivery-detail.tsx';
import { DispatchPanel } from '../../../../src/deliveries/dispatch-panel.tsx';
import { namesFor } from '../../../../src/deliveries/names.ts';
import { NoAccess } from '../../../../src/ops/no-access.tsx';
import { NoticeProvider } from '../../../../src/ops/notice.tsx';
import { PERMISSION, UUID, type Delivery } from '../../../../src/ops/types.ts';
import { AdminShell } from '../../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('deliveries.title') };
}

export default async function DeliveryPage({
  params,
}: {
  readonly params: Promise<{ readonly deliveryId: string }>;
}) {
  const { deliveryId } = await params;
  if (!UUID.test(deliveryId)) notFound();
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const { session } = gate;
  const keys = new Set(session.permissionKeys);
  if (!keys.has(PERMISSION.deliveryView)) {
    return (
      <AdminShell session={session} activeId="deliveries" title={t('deliveries.title')}>
        <NoAccess scope="deliveries" />
      </AdminShell>
    );
  }
  const [result, names] = await Promise.all([
    serverGet<Delivery>(`delivery/admin/deliveries/${deliveryId}`),
    namesFor(keys),
  ]);
  if (result.kind === 'signed-out') redirect('/session-ended');
  if (result.kind === 'not-found') notFound();
  if (result.kind !== 'ok') {
    return (
      <AdminShell session={session} activeId="deliveries" title={t('deliveries.title')}>
        <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />
      </AdminShell>
    );
  }
  const delivery = result.body;
  const title = t('deliveries.detail.title', { reference: delivery.externalReference });
  return (
    <AdminShell session={session} activeId="deliveries" title={title}>
      <BackLink href="/deliveries" label={t('deliveries.back')} />
      <h1 className="mb-4 mt-2 break-all text-2xl font-semibold">{title}</h1>
      <NoticeProvider>
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
          <DeliveryDetail
            delivery={delivery}
            merchantName={names.merchants.get(delivery.merchantId)}
            couriers={names.couriers}
          />
          <div className="flex flex-col gap-4">
            <DispatchPanel
              deliveryId={delivery.id}
              status={delivery.status}
              couriers={names.activeCouriers}
              quotedVehicle={delivery.quote.vehicle}
              canDispatch={keys.has(PERMISSION.deliveryDispatch)}
              canCancel={keys.has(PERMISSION.deliveryCancel)}
              csrfToken={session.csrfToken}
            />
          </div>
        </div>
      </NoticeProvider>
    </AdminShell>
  );
}
