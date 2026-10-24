import { Banner, LoadError } from '@mondapac-drive/ui';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { namesFor } from '../../../src/deliveries/names.ts';
import { LiveMap } from '../../../src/live-map/live-map.tsx';
import { mapDeliveries } from '../../../src/live-map/map-deliveries.ts';
import type { MapDelivery } from '../../../src/live-map/model.ts';
import { NoAccess } from '../../../src/ops/no-access.tsx';
import { PERMISSION } from '../../../src/ops/types.ts';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { panelHostFor } from '../../../src/server/bff.ts';
import { panelConfig } from '../../../src/server/config.ts';
import { mapConfig } from '../../../src/server/map-config.ts';
import { requireSession } from '../../../src/server/session.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('live-map.title') };
}

/**
 * The dispatcher's live map (`tracking.map.view`). Deliveries and their exceptions are read only
 * with `delivery.delivery.view`, courier names only with `identity.courier-account.view`; the
 * browser gets ids, statuses and rounded points, never an address or a contact.
 */
export default async function LiveMapPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const { session } = gate;
  const keys = new Set(session.permissionKeys);
  const title = t('live-map.title');
  if (!keys.has(PERMISSION.mapView)) {
    return (
      <AdminShell session={session} activeId="home" title={title}>
        <NoAccess scope="live-map" />
      </AdminShell>
    );
  }
  const host = panelHostFor(panelConfig(), (await headers()).get('host'));
  const map = mapConfig();
  const center = host === undefined ? undefined : map.centers[host.marketId];
  const [read, names] = await Promise.all([
    keys.has(PERMISSION.deliveryView) ? mapDeliveries() : Promise.resolve(null),
    namesFor(keys),
  ]);
  if (read?.kind === 'signed-out') redirect('/session-ended');
  const deliveries: readonly MapDelivery[] = read?.kind === 'ok' ? read.deliveries : [];
  return (
    <AdminShell session={session} activeId="live-map" title={title}>
      <div className="mb-4 flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="text-fg-muted">{t('live-map.intro')}</p>
      </div>
      {read === null || read.kind === 'ok' ? null : (
        <div className="mb-4">
          <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />
        </div>
      )}
      {center === undefined ? (
        <Banner tone="attention">{t('live-map.no-center')}</Banner>
      ) : (
        <LiveMap
          styleUrl={map.styleUrl}
          center={center}
          zoom={map.zoom}
          deliveries={deliveries}
          courierNames={Object.fromEntries(names.couriers)}
        />
      )}
    </AdminShell>
  );
}
