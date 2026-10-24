import { Tabs } from '@mondapac-drive/ui';

/** The two tabs of "Roles & permissions" (ux B1, B2): links, with the current one marked. */
export function TeamTabs({
  active,
  labels,
}: {
  readonly active: 'admins' | 'roles';
  /** Absent when the actor may not see roles: the page then has no tabs. */
  readonly labels: { readonly nav: string; readonly admins: string; readonly roles: string } | null;
}) {
  if (labels === null) return null;
  return (
    <div className="mb-4">
      <Tabs
        label={labels.nav}
        activeId={active}
        items={[
          { id: 'admins', href: '/team', label: labels.admins },
          { id: 'roles', href: '/roles', label: labels.roles },
        ]}
      />
    </div>
  );
}

/** The tab labels from a translator (server pages). */
export function tabLabels(t: (key: string) => string) {
  return {
    nav: t('identity.members.tab.label'),
    admins: t('identity.members.tab.admins'),
    roles: t('identity.members.tab.roles'),
  };
}
