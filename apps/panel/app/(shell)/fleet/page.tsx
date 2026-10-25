import { LoadError, Tabs } from '@mondapac-drive/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { namesFor } from '../../../src/deliveries/names.ts';
import { ExpiringTable } from '../../../src/fleet/expiring-table.tsx';
import { FleetTable } from '../../../src/fleet/fleet-table.tsx';
import {
  COURIER_FILTERS,
  FLEET_PERMISSION,
  type CourierFilter,
  type CourierListPage,
  type ExpiringDocument,
} from '../../../src/fleet/types.ts';
import { EXPIRY_WINDOW_DAYS } from '../../../src/ops/home-counts.ts';
import { NoAccess } from '../../../src/ops/no-access.tsx';
import { UUID } from '../../../src/ops/types.ts';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../src/server/server-fetch.ts';
import { requireSession } from '../../../src/server/session.ts';

const PAGE = 50;

/** The courier tabs, then the documents expiring soon (a list of documents, not couriers). */
const TABS = [...COURIER_FILTERS, 'expiring'] as const;
type FleetTab = (typeof TABS)[number];

interface ExpiringPage {
  readonly items: readonly ExpiringDocument[];
  readonly next: string | null;
}

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
  const filter: FleetTab =
    typeof rawShow === 'string' && (TABS as readonly string[]).includes(rawShow)
      ? (rawShow as FleetTab)
      : 'applicant';
  const after = typeof rawAfter === 'string' && UUID.test(rawAfter) ? rawAfter : null;
  const now = new Date();
  const query = new URLSearchParams({ limit: String(PAGE) });
  if (filter === 'expiring') {
    query.set('before', new Date(now.getTime() + EXPIRY_WINDOW_DAYS * 86_400_000).toISOString());
  } else if (filter !== 'all') {
    query.set('status', filter satisfies CourierFilter);
  }
  if (after !== null) query.set('after', after);
  const [result, names] = await Promise.all([
    filter === 'expiring'
      ? serverGet<ExpiringPage>(`fleet/admin/documents/expiring?${query.toString()}`)
      : serverGet<CourierListPage>(`fleet/admin/couriers?${query.toString()}`),
    namesFor(keys),
  ]);
  if (result.kind === 'signed-out') redirect('/session-ended');
  const hrefOf = (show: FleetTab) => (show === 'applicant' ? '/fleet' : `/fleet?show=${show}`);
  const next = result.kind === 'ok' ? result.body.next : null;
  return (
    <AdminShell session={session} activeId="fleet" title={title}>
      <div className="mb-4 flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="text-fg-muted">
          {filter === 'expiring' ? t('fleet.expiring.intro') : t('fleet.intro')}
        </p>
      </div>
      <div className="mb-4">
        <Tabs
          label={t('fleet.filter.label')}
          activeId={filter}
          items={TABS.map((id) => ({
            id,
            href: hrefOf(id),
            label: t(`fleet.filter.${id}`),
          }))}
        />
      </div>
      {result.kind === 'ok' ? (
        <>
          {filter === 'expiring' ? (
            <ExpiringTable
              documents={(result.body as ExpiringPage).items}
              couriers={names.couriers}
              firstPage={after === null}
              now={now}
            />
          ) : (
            <FleetTable
              couriers={(result.body as CourierListPage).items}
              names={names.couriers}
              firstPage={after === null}
            />
          )}
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
