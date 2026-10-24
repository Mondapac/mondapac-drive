import { LoadError } from '@mondapac-drive/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { CouriersTable } from '../../../src/couriers/couriers-table.tsx';
import { InviteCourierButton } from '../../../src/couriers/invite-courier-button.tsx';
import { NoAccess } from '../../../src/ops/no-access.tsx';
import { NoticeProvider } from '../../../src/ops/notice.tsx';
import { PERMISSION, UUID, type CourierPage } from '../../../src/ops/types.ts';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../src/server/server-fetch.ts';
import { requireSession } from '../../../src/server/session.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('couriers.title') };
}

export default async function CouriersPage({
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
  const title = t('couriers.title');
  if (!keys.has(PERMISSION.courierView)) {
    return (
      <AdminShell session={session} activeId="home" title={title}>
        <NoAccess scope="couriers" />
      </AdminShell>
    );
  }
  const { after: rawAfter } = await searchParams;
  const after = typeof rawAfter === 'string' && UUID.test(rawAfter) ? rawAfter : null;
  const result = await serverGet<CourierPage>(
    `identity/admin/couriers${after === null ? '' : `?after=${after}`}`,
  );
  if (result.kind === 'signed-out') redirect('/session-ended');
  return (
    <AdminShell session={session} activeId="couriers" title={title}>
      <NoticeProvider>
        <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold">{title}</h1>
            <p className="text-fg-muted">{t('couriers.intro')}</p>
          </div>
          {keys.has(PERMISSION.courierInvite) ? (
            <InviteCourierButton csrfToken={session.csrfToken} />
          ) : null}
        </div>
        {result.kind === 'ok' ? (
          <>
            <CouriersTable
              page={result.body}
              after={after}
              csrfToken={session.csrfToken}
              canDisable={keys.has(PERMISSION.courierDisable)}
            />
            {result.body.next === null || !UUID.test(result.body.next) ? null : (
              <p className="mt-4">
                <a
                  className="inline-flex min-h-12 items-center font-medium text-link underline"
                  href={`/couriers?after=${result.body.next}`}
                >
                  {t('couriers.next-page')}
                </a>
              </p>
            )}
          </>
        ) : (
          <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />
        )}
      </NoticeProvider>
    </AdminShell>
  );
}
