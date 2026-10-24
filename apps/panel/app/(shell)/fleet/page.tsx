import { LoadError, Tabs } from '@mondapac-drive/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { FleetTable } from '../../../src/fleet/fleet-table.tsx';
import {
  COURIER_FILTERS,
  FLEET_PERMISSION,
  type CourierFilter,
  type CourierListPage,
} from '../../../src/fleet/types.ts';
import { NoAccess } from '../../../src/ops/no-access.tsx';
import { UUID } from '../../../src/ops/types.ts';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../src/server/server-fetch.ts';
import { requireSession } from '../../../src/server/session.ts';

const PAGE = 50;

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('fleet.title') };
}

/** The Market's fleet couriers (`fleet.courier.view`), applicants first. */
export default async function FleetPage({
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
  const title = t('fleet.title');
  if (!keys.has(FLEET_PERMISSION.courierView)) {
    return (
      <AdminShell session={session} activeId="home" title={title}>
        <NoAccess scope="fleet" />
      </AdminShell>
    );
  }
  const { show: rawShow, after: rawAfter } = await searchParams;
  const filter: CourierFilter =
    typeof rawShow === 'string' && (COURIER_FILTERS as readonly string[]).includes(rawShow)
      ? (rawShow as CourierFilter)
      : 'applicant';
  const after = typeof rawAfter === 'string' && UUID.test(rawAfter) ? rawAfter : null;
  const query = new URLSearchParams({ limit: String(PAGE) });
  if (filter !== 'all') query.set('status', filter);
  if (after !== null) query.set('after', after);
  const result = await serverGet<CourierListPage>(`fleet/admin/couriers?${query.toString()}`);
  if (result.kind === 'signed-out') redirect('/session-ended');
  const hrefOf = (show: CourierFilter) => (show === 'applicant' ? '/fleet' : `/fleet?show=${show}`);
  const next = result.kind === 'ok' ? result.body.next : null;
  return (
    <AdminShell session={session} activeId="fleet" title={title}>
      <div className="mb-4 flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="text-fg-muted">{t('fleet.intro')}</p>
      </div>
      <div className="mb-4">
        <Tabs
          label={t('fleet.filter.label')}
          activeId={filter}
          items={COURIER_FILTERS.map((id) => ({
            id,
            href: hrefOf(id),
            label: t(`fleet.filter.${id}`),
          }))}
        />
      </div>
      {result.kind === 'ok' ? (
        <>
          <FleetTable couriers={result.body.items} firstPage={after === null} />
          <p className="mt-4 flex gap-4">
            {after === null ? null : (
              <a
                className="inline-flex min-h-12 items-center font-medium text-link underline"
                href={hrefOf(filter)}
              >
                {t('fleet.first-page')}
              </a>
            )}
            {next === null || !UUID.test(next) ? null : (
              <a
                className="inline-flex min-h-12 items-center font-medium text-link underline"
                href={`${hrefOf(filter)}${filter === 'applicant' ? '?' : '&'}after=${next}`}
              >
                {t('fleet.next-page')}
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
