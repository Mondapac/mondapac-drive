import { Button, LoadError, Select, Tabs } from '@mondapac-drive/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { DeliveriesTable } from '../../../src/deliveries/deliveries-table.tsx';
import {
  LIST_TAB_IDS,
  listHref,
  parseListFilter,
  statusesOf,
} from '../../../src/deliveries/filters.ts';
import { readListPage } from '../../../src/deliveries/list-page.ts';
import { namesFor, shortId } from '../../../src/deliveries/names.ts';
import { NoAccess } from '../../../src/ops/no-access.tsx';
import { PERMISSION, type DeliveryPage } from '../../../src/ops/types.ts';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../src/server/server-fetch.ts';
import { requireSession } from '../../../src/server/session.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('deliveries.title') };
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
  const filter = parseListFilter(await searchParams);
  const [result, names] = await Promise.all([
    readListPage(filter, (path) => serverGet<DeliveryPage>(path)),
    namesFor(keys),
  ]);
  if (result.kind === 'signed-out') redirect('/session-ended');
  const { merchantId } = filter;
  return (
    <AdminShell session={session} activeId="deliveries" title={title}>
      <div className="mb-4 flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="text-fg-muted">{t('deliveries.intro')}</p>
      </div>
      <div className="mb-4">
        <Tabs
          label={t('deliveries.filter.label')}
          activeId={filter.show}
          items={LIST_TAB_IDS.map((id) => ({
            id,
            href: listHref({ show: id, merchantId }),
            label: t(`deliveries.filter.${id}`),
          }))}
        />
      </div>
      <form
        method="get"
        action="/deliveries"
        className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end"
      >
        {filter.show === 'all' ? null : <input type="hidden" name="show" value={filter.show} />}
        {merchantId === null ? null : <input type="hidden" name="merchant" value={merchantId} />}
        <div className="sm:w-72">
          <Select
            name="status"
            label={t('deliveries.filter.status')}
            placeholder={t('deliveries.filter.any-status')}
            defaultValue={filter.status ?? ''}
            options={statusesOf(filter.show).map((status) => ({
              value: status,
              label: t(`deliveries.status.${status}`),
            }))}
          />
        </div>
        <div>
          <Button type="submit" variant="secondary">
            {t('deliveries.filter.apply')}
          </Button>
        </div>
      </form>
      {merchantId === null ? null : (
        <p className="mb-4 flex flex-wrap items-center gap-x-4 text-sm">
          <span>
            {t('deliveries.filter.merchant', {
              name: names.merchants.get(merchantId) ?? shortId(merchantId),
            })}
          </span>
          <a
            className="inline-flex min-h-12 items-center font-medium text-link underline"
            href={listHref({ ...filter, merchantId: null, before: null })}
          >
            {t('deliveries.filter.all-merchants')}
          </a>
        </p>
      )}
      {filter.show === 'attention' ? (
        <p className="mb-4 text-sm text-fg-muted">{t('deliveries.filter.attention-help')}</p>
      ) : null}
      {result.kind === 'ok' ? (
        <>
          <DeliveriesTable
            items={result.items}
            merchants={names.merchants}
            couriers={names.couriers}
          />
          <p className="mt-4 flex gap-4">
            {filter.before === null ? null : (
              <a
                className="inline-flex min-h-12 items-center font-medium text-link underline"
                href={listHref({ ...filter, before: null })}
              >
                {t('deliveries.first-page')}
              </a>
            )}
            {result.next === null ? null : (
              <a
                className="inline-flex min-h-12 items-center font-medium text-link underline"
                href={listHref({ ...filter, before: result.next })}
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
