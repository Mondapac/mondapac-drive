import { LoadError } from '@mondapac-drive/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { RolesNoAccess } from '../../../src/roles/roles-page-gate.tsx';
import { memberCounts } from '../../../src/roles/member-counts.ts';
import { RolesTable } from '../../../src/roles/roles-table.tsx';
import type { RoleCatalogue } from '../../../src/roles/types.ts';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../src/server/server-fetch.ts';
import { requireSession } from '../../../src/server/session.ts';
import { TeamTabs, tabLabels } from '../../../src/team/team-tabs.tsx';

const VIEW_PERMISSION = 'identity.platform-role.view';
const TEAM_PERMISSION = 'identity.admin-account.view';
const CREATE_PERMISSION = 'identity.platform-role.create';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('identity.members.title.admin') };
}

export default async function RolesPageRoute() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  if (!gate.session.permissionKeys.includes(VIEW_PERMISSION)) {
    return <RolesNoAccess session={gate.session} />;
  }
  const [result, members] = await Promise.all([
    serverGet<RoleCatalogue>('identity/admin/roles'),
    gate.session.permissionKeys.includes(TEAM_PERMISSION) ? memberCounts() : Promise.resolve(null),
  ]);
  if (result.kind === 'signed-out') redirect('/session-ended');
  const title = t('identity.members.title.admin');
  return (
    <AdminShell session={gate.session} activeId="team" title={title}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{title}</h1>
        {gate.session.permissionKeys.includes(CREATE_PERMISSION) ? (
          <a
            className="inline-flex h-(--mp-size-control) items-center rounded-md bg-accent px-4 font-medium text-on-accent hover:bg-accent-hover"
            href="/roles/new"
          >
            {t('identity.roles.action.create')}
          </a>
        ) : null}
      </div>
      <TeamTabs active="roles" labels={tabLabels(t)} />
      {result.kind === 'ok' ? (
        <RolesTable roles={result.body.items} members={members} />
      ) : (
        <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />
      )}
    </AdminShell>
  );
}
