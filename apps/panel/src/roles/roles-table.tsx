import { Badge, CARD_TABLE, EmptyState, Icon, type BadgeTone } from '@mondapac-drive/ui';
import { getTranslations } from 'next-intl/server';
import { roleName } from './role-name.ts';
import type { RoleRecord } from './types.ts';

const KINDS = ['system', 'default', 'custom'] as const;
const TONE: Record<RoleRecord['kind'], BadgeTone> = {
  system: 'neutral',
  default: 'neutral',
  custom: 'neutral',
};

/** B2: roles grouped System, Default, Custom with their permission counts (read only). */
export async function RolesTable({
  roles,
  members = null,
}: {
  readonly roles: readonly RoleRecord[];
  /** Active accounts per role id; null leaves the Members column out. */
  readonly members?: ReadonlyMap<string, number> | null;
}) {
  const t = await getTranslations();
  return (
    <div className="flex flex-col gap-6">
      {KINDS.map((kind) => {
        const rows = roles.filter((role) => role.kind === kind);
        if (rows.length === 0 && kind !== 'custom') return null;
        return (
          <section key={kind} aria-labelledby={`roles-${kind}`}>
            <h2 id={`roles-${kind}`} className="mb-2 text-lg font-semibold">
              {t(`identity.roles.group.${kind}`)}
            </h2>
            {rows.length === 0 ? (
              <EmptyState
                icon="key"
                title={t('identity.roles.empty-custom.title')}
                body={t('identity.roles.empty-custom.body')}
              />
            ) : (
              <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
                {/* Fixed layout with shared widths, so the System, Default and Custom tables
                    line their columns up with each other; Role takes what is left. */}
                <table className={`${CARD_TABLE.table} lg:min-w-180 lg:table-fixed`}>
                  <caption className="sr-only">{t(`identity.roles.group.${kind}`)}</caption>
                  <colgroup className="max-lg:hidden">
                    <col />
                    <col className="w-36" />
                    <col className="w-36" />
                    {members === null ? null : <col className="w-32" />}
                    <col className="w-28" />
                  </colgroup>
                  <thead className={CARD_TABLE.head}>
                    <tr>
                      <th scope="col" className="px-4 py-3 font-medium">
                        {t('identity.roles.label.role')}
                      </th>
                      <th scope="col" className="px-4 py-3 font-medium">
                        {t('identity.roles.label.type')}
                      </th>
                      <th scope="col" className="px-4 py-3 font-medium">
                        {t('identity.roles.label.permissions')}
                      </th>
                      {members === null ? null : (
                        <th scope="col" className="px-4 py-3 font-medium">
                          {t('identity.roles.label.members')}
                        </th>
                      )}
                      <th scope="col" className="px-4 py-3 text-end font-medium">
                        {t('identity.members.actions')}
                      </th>
                    </tr>
                  </thead>
                  <tbody className={CARD_TABLE.body}>
                    {rows.map((role) => {
                      const name = roleName(t, role);
                      return (
                        <tr key={role.roleId} className={CARD_TABLE.row}>
                          <td className={`${CARD_TABLE.cell} break-words font-medium text-fg`}>
                            {name}
                          </td>
                          <td className={CARD_TABLE.corner}>
                            <Badge tone={TONE[role.kind]}>
                              {role.kind === 'system' ? (
                                <Icon name="lock" className="size-[1em]" />
                              ) : null}
                              {t(`identity.roles.type.${role.kind}`)}
                            </Badge>
                          </td>
                          <td
                            className={CARD_TABLE.labelled}
                            data-label={t('identity.roles.label.permissions')}
                          >
                            {role.kind === 'system'
                              ? t('identity.roles.permissions-all')
                              : role.permissionCount === 0
                                ? t('identity.roles.permissions-none')
                                : t('identity.members.role.permission-count', {
                                    count: role.permissionCount,
                                  })}
                          </td>
                          {members === null ? null : (
                            <td
                              className={CARD_TABLE.labelled}
                              data-label={t('identity.roles.label.members')}
                            >
                              {t('identity.roles.members-count', {
                                count: members.get(role.roleId) ?? 0,
                              })}
                            </td>
                          )}
                          <td
                            className={`${CARD_TABLE.cell} text-end max-lg:col-span-2 max-lg:text-start`}
                          >
                            <a
                              className="font-medium text-link underline"
                              href={`/roles/${role.roleId}`}
                            >
                              {t(
                                role.kind === 'custom' && role.actions.edit.allowed
                                  ? 'identity.roles.action.edit'
                                  : 'identity.roles.action.view',
                              )}{' '}
                              <span className="sr-only">{name}</span>
                            </a>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
