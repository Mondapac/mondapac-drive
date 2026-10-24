import { LoadError } from '@mondapac-drive/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../src/server/server-fetch.ts';
import { requireSession } from '../../../src/server/session.ts';
import { InviteAdminButton } from '../../../src/team/invite-admin-button.tsx';
import { NoticeProvider } from '../../../src/team/notice.tsx';
import { TeamTable } from '../../../src/team/team-table.tsx';
import { TeamTabs, tabLabels } from '../../../src/team/team-tabs.tsx';
import type { PlatformRole, TeamPage } from '../../../src/team/types.ts';

const VIEW_PERMISSION = 'identity.admin-account.view';
const ROLES_PERMISSION = 'identity.platform-role.view';
const ASSIGN_PERMISSION = 'identity.platform-role.assign';
const INVITE_PERMISSION = 'identity.admin-account.invite';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('identity.members.title.admin') };
}

export default async function TeamPageRoute({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  if (!gate.session.permissionKeys.includes(VIEW_PERMISSION)) {
    return (
      <AdminShell
        session={gate.session}
        activeId="home"
        title={t('identity.members.no-access.title')}
      >
        <h1 className="mb-2 text-2xl font-semibold">{t('identity.members.no-access.title')}</h1>
        <p className="text-fg-muted">{t('identity.members.no-access.body')}</p>
        <p className="mt-4">
          <a className="font-medium text-link underline" href="/">
            {t('identity.members.no-access.action')}
          </a>
        </p>
      </AdminShell>
    );
  }
  const { after: rawAfter } = await searchParams;
  const after = typeof rawAfter === 'string' && UUID.test(rawAfter) ? rawAfter : null;
  const title = t('identity.members.title.admin');
  // Each action shows only to an actor who holds its key; the server checks every command again.
  const keys = new Set(gate.session.permissionKeys);
  const canAssign = keys.has(ASSIGN_PERMISSION);
  const canInvite = keys.has(INVITE_PERMISSION);
  const needsRoles = keys.has(ROLES_PERMISSION) && (canAssign || canInvite);
  const [result, rolesResult] = await Promise.all([
    serverGet<TeamPage>(`identity/admin/team${after === null ? '' : `?after=${after}`}`),
    needsRoles
      ? serverGet<{ readonly items: readonly PlatformRole[] }>('identity/admin/roles')
      : Promise.resolve(null),
  ]);
  if (result.kind === 'signed-out' || rolesResult?.kind === 'signed-out') {
    redirect('/session-ended');
  }
  // Without the role list the role actions are left out, not shown broken.
  const roles = rolesResult?.kind === 'ok' ? rolesResult.body.items : undefined;
  return (
    <AdminShell session={gate.session} activeId="team" title={title}>
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      <TeamTabs active="admins" labels={keys.has(ROLES_PERMISSION) ? tabLabels(t) : null} />
      {result.kind === 'ok' ? (
        <>
          <NoticeProvider>
            {canInvite && roles !== undefined ? (
              <div className="mb-4 flex justify-end">
                <InviteAdminButton roles={roles} csrfToken={gate.session.csrfToken} />
              </div>
            ) : null}
            <TeamTable
              page={result.body}
              after={after}
              csrfToken={gate.session.csrfToken}
              roles={canAssign ? roles : undefined}
            />
          </NoticeProvider>
          {result.body.next === null || !UUID.test(result.body.next) ? null : (
            <p className="mt-4">
              <a
                className="font-medium text-link underline"
                href={`/team?after=${result.body.next}`}
              >
                {t('identity.members.next-page')}
              </a>
            </p>
          )}
        </>
      ) : (
        <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />
      )}
    </AdminShell>
  );
}
