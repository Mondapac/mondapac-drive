import { LoadError, Tabs } from '@mondapac-drive/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { DeliveriesTable } from '../../../src/deliveries/deliveries-table.tsx';
import { namesFor } from '../../../src/deliveries/names.ts';
import { NoAccess } from '../../../src/ops/no-access.tsx';
import {
  DELIVERY_FILTERS,
  PERMISSION,
  UUID,
  type DeliveryFilter,
  type DeliveryPage,
} from '../../../src/ops/types.ts';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../src/server/server-fetch.ts';
import { requireSession } from '../../../src/server/session.ts';

const FILTERS = Object.keys(DELIVERY_FILTERS) as DeliveryFilter[];

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('deliveries.title') };
}

/** The query of one page: the filter's statuses and the cursor, both from closed sets. */
function listQuery(filter: DeliveryFilter, before: string | null): string {
  const query = new URLSearchParams();
  const statuses: readonly string[] = DELIVERY_FILTERS[filter];
  if (statuses.length > 0) query.set('status', statuses.join(','));
  if (before !== null) query.set('before', before);
  const text = query.toString();
  return text === '' ? '' : `?${text}`;
}

export default async function DeliveriesPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const { session } = gate;
  const keys = new Set(session.permissionKeys);
  const title = t('deliveries.title');
  if (!keys.has(PERMISSION.deliveryView)) {
    return (
      <AdminShell session={session} activeId="home" title={title}>
        <NoAccess scope="deliveries" />
      </AdminShell>
    );
  }
  const { show: rawShow, before: rawBefore } = await searchParams;
  const filter: DeliveryFilter =
    typeof rawShow === 'string' && (FILTERS as string[]).includes(rawShow)
      ? (rawShow as DeliveryFilter)
      : 'all';
  const before = typeof rawBefore === 'string' && UUID.test(rawBefore) ? rawBefore : null;
  const [result, names] = await Promise.all([
    serverGet<DeliveryPage>(`delivery/admin/deliveries${listQuery(filter, before)}`),
    namesFor(keys),
  ]);
  if (result.kind === 'signed-out') redirect('/session-ended');
  const hrefOf = (show: DeliveryFilter) =>
    show === 'all' ? '/deliveries' : `/deliveries?show=${show}`;
  return (
    <AdminShell session={session} activeId="deliveries" title={title}>
      <div className="mb-4 flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="text-fg-muted">{t('deliveries.intro')}</p>
      </div>
      <div className="mb-4">
        <Tabs
          label={t('deliveries.filter.label')}
          activeId={filter}
          items={FILTERS.map((id) => ({
            id,
            href: hrefOf(id),
            label: t(`deliveries.filter.${id}`),
          }))}
        />
      </div>
      {result.kind === 'ok' ? (
        <>
          <DeliveriesTable
            items={result.body.items}
            merchants={names.merchants}
            couriers={names.couriers}
          />
          <p className="mt-4 flex gap-4">
            {before === null ? null : (
              <a
                className="inline-flex min-h-12 items-center font-medium text-link underline"
                href={hrefOf(filter)}
              >
                {t('deliveries.first-page')}
              </a>
            )}
            {result.body.next === null || !UUID.test(result.body.next) ? null : (
              <a
                className="inline-flex min-h-12 items-center font-medium text-link underline"
                href={`${hrefOf(filter)}${filter === 'all' ? '?' : '&'}before=${result.body.next}`}
              >
                {t('deliveries.next-page')}
              </a>
            )}
          </p>
        </>
      ) : (
        <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />
      )}
    </AdminShell>
  );
}
