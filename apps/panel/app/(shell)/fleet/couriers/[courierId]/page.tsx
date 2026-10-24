import { BackLink, LoadError } from '@mondapac-drive/ui';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { CourierView } from '../../../../../src/fleet/courier-view.tsx';
import { FLEET_PERMISSION, type FleetCourier } from '../../../../../src/fleet/types.ts';
import { NoAccess } from '../../../../../src/ops/no-access.tsx';
import { NoticeProvider } from '../../../../../src/ops/notice.tsx';
import { UUID } from '../../../../../src/ops/types.ts';
import { shortId } from '../../../../../src/shared/short-id.ts';
import { AdminShell } from '../../../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../../src/server/session.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('fleet.title') };
}

/** One fleet courier: standing, vehicles and documents, with the decisions the role allows. */
export default async function FleetCourierPage({
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
  if (!keys.has(FLEET_PERMISSION.courierView)) {
    return (
      <AdminShell session={session} activeId="fleet" title={t('fleet.title')}>
        <NoAccess scope="fleet" />
      </AdminShell>
    );
  }
  const result = await serverGet<FleetCourier>(`fleet/admin/couriers/${courierId}`);
  if (result.kind === 'signed-out') redirect('/session-ended');
  if (result.kind === 'not-found') notFound();
  const title = t('fleet.courier.title', { id: shortId(courierId) });
  return (
    <AdminShell session={session} activeId="fleet" title={title}>
      <BackLink href="/fleet" label={t('fleet.back')} />
      <NoticeProvider>
        <h1 className="mb-4 mt-2 break-words text-2xl font-semibold">{title}</h1>
        {result.kind === 'ok' ? (
          <CourierView
            courier={result.body}
            csrfToken={session.csrfToken}
            can={{
              decide: keys.has(FLEET_PERMISSION.courierDecide),
              review: keys.has(FLEET_PERMISSION.documentReview),
              manageVehicles: keys.has(FLEET_PERMISSION.vehicleManage),
            }}
          />
        ) : (
          <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />
        )}
      </NoticeProvider>
    </AdminShell>
  );
}
