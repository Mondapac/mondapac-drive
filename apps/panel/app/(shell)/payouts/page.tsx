import { LoadError, Tabs } from '@mondapac-drive/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { namesFor } from '../../../src/deliveries/names.ts';
import { NoAccess } from '../../../src/ops/no-access.tsx';
import { NoticeProvider } from '../../../src/ops/notice.tsx';
import { UUID } from '../../../src/ops/types.ts';
import { LinesTable } from '../../../src/payouts/lines-table.tsx';
import {
  LINE_FILTERS,
  PAYOUT_PERMISSION,
  type LineFilter,
  type LinePage,
} from '../../../src/payouts/types.ts';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../src/server/server-fetch.ts';
import { requireSession } from '../../../src/server/session.ts';

const FILTERS = Object.keys(LINE_FILTERS) as LineFilter[];
const PAGE = 50;

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('payouts.title') };
}

/** Courier payout lines (`payouts.ledger.view`): held and unresolved first, with the settle tool. */
export default async function PayoutsPage({
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
  const title = t('payouts.title');
  if (!keys.has(PAYOUT_PERMISSION.ledgerView)) {
    return (
      <AdminShell session={session} activeId="home" title={title}>
        <NoAccess scope="payouts" />
      </AdminShell>
    );
  }
  const { show: rawShow, after: rawAfter } = await searchParams;
  const filter: LineFilter =
    typeof rawShow === 'string' && (FILTERS as string[]).includes(rawShow)
      ? (rawShow as LineFilter)
      : 'attention';
  const after = typeof rawAfter === 'string' && UUID.test(rawAfter) ? rawAfter : null;
  const query = new URLSearchParams({
    status: LINE_FILTERS[filter].join(','),
    limit: String(PAGE),
  });
  if (after !== null) query.set('after', after);
  const [result, names] = await Promise.all([
    serverGet<LinePage>(`payouts/admin/lines?${query.toString()}`),
    namesFor(keys),
  ]);
  if (result.kind === 'signed-out') redirect('/session-ended');
  const hrefOf = (show: LineFilter) =>
    show === 'attention' ? '/payouts' : `/payouts?show=${show}`;
  const next = result.kind === 'ok' ? result.body.next : undefined;
  return (
    <AdminShell session={session} activeId="payouts" title={title}>
      <NoticeProvider>
        <div className="mb-4 flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{title}</h1>
          <p className="text-fg-muted">{t('payouts.intro')}</p>
        </div>
        <div className="mb-4">
          <Tabs
            label={t('payouts.filter.label')}
            activeId={filter}
            items={FILTERS.map((id) => ({
              id,
              href: hrefOf(id),
              label: t(`payouts.filter.${id}`),
            }))}
          />
        </div>
        {result.kind === 'ok' ? (
          <>
            <LinesTable
              lines={result.body.lines}
              couriers={names.couriers}
              canSettle={keys.has(PAYOUT_PERMISSION.lineSettle)}
              csrfToken={session.csrfToken}
            />
            <p className="mt-4 flex gap-4">
              {after === null ? null : (
                <a
                  className="inline-flex min-h-12 items-center font-medium text-link underline"
                  href={hrefOf(filter)}
                >
                  {t('payouts.first-page')}
                </a>
              )}
              {next === undefined || !UUID.test(next) ? null : (
                <a
                  className="inline-flex min-h-12 items-center font-medium text-link underline"
                  href={`${hrefOf(filter)}${filter === 'attention' ? '?' : '&'}after=${next}`}
                >
                  {t('payouts.next-page')}
                </a>
              )}
            </p>
          </>
        ) : (
          <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />
        )}
      </NoticeProvider>
    </AdminShell>
  );
}
