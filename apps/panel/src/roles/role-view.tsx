import { BackLink, Badge, Banner, Icon, LinkButton } from '@mondapac-drive/ui';
import { getTranslations } from 'next-intl/server';
import { groupByResource, humanise, roleName } from './role-name.ts';
import type { RoleCatalogue, RoleRecord } from './types.ts';

/** B3 read-only: the role, why it cannot be edited here, and its permissions by resource. */
export async function RoleView({
  role,
  catalogue,
  canDuplicate = false,
}: {
  readonly role: RoleRecord;
  readonly catalogue: RoleCatalogue;
  readonly canDuplicate?: boolean;
}) {
  const t = await getTranslations();
  const held = new Set(role.permissionKeys);
  // A system role confers every key of the scope.
  const keys = role.kind === 'system' ? catalogue.keys.map((entry) => entry.key) : [...held];
  const isProtected = new Set(catalogue.keys.filter((entry) => entry.protected).map((e) => e.key));
  const groups = groupByResource(keys);
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col items-start gap-2">
        <BackLink href="/roles" label={t('identity.roles.back')} />
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <h1 className="min-w-0 break-words text-2xl font-semibold">{roleName(t, role)}</h1>
            <Badge tone="neutral">
              {role.kind === 'system' ? <Icon name="lock" className="size-[1em]" /> : null}
              {t(`identity.roles.type.${role.kind}`)}
            </Badge>
          </div>
          {canDuplicate ? (
            <LinkButton
              variant="secondary"
              href={`/roles/new?from=${role.roleId}`}
              className="max-sm:w-full"
            >
              {t('identity.roles.action.duplicate')}
            </LinkButton>
          ) : null}
        </div>
      </div>
      {role.kind === 'custom' ? null : (
        <Banner tone="info">{t(`identity.roles.read-only.${role.kind}`)}</Banner>
      )}
      <p className="text-fg-muted">
        {role.kind === 'system'
          ? t('identity.roles.permissions-all')
          : t('identity.roles.selected', { selected: keys.length, total: catalogue.keys.length })}
      </p>
      {groups.length === 0 ? (
        <p className="text-fg-muted">{t('identity.roles.permissions-none')}</p>
      ) : (
        groups.map(([resource, resourceKeys]) => (
          <section key={resource} className="rounded-lg border border-line bg-surface p-5">
            <h2 className="mb-2 font-semibold">
              {t.has(`permission.resource.${resource}`)
                ? t(`permission.resource.${resource}`)
                : humanise(resource.split('.')[1] ?? resource)}
            </h2>
            <ul className="flex flex-col gap-1">
              {resourceKeys.map((key) => (
                <li key={key} className="flex flex-wrap items-center gap-2">
                  <Icon name="check" className="text-success-fg" />
                  <span className="sr-only">{t('identity.roles.included')}</span>
                  <span>
                    {t.has(`permission.${key}.label`)
                      ? t(`permission.${key}.label`)
                      : humanise(key.split('.').slice(2).join(' '))}
                  </span>
                  {isProtected.has(key) ? (
                    <Badge tone="neutral">{t('identity.roles.protected')}</Badge>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
