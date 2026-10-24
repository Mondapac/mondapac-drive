import type { SelectOption } from '@mondapac-drive/ui';
import { roleLabel, type RoleTranslator } from './role-label.ts';
import type { PlatformRole } from './types.ts';

type Translator = RoleTranslator & {
  (key: string, values?: Record<string, string | number>): string;
};

/**
 * The role picker's options (ux D1, D2): each shows its permission count; a role the actor may
 * not give stays visible and disabled, with the reason on the same line. Only a hint: the
 * command checks again.
 */
export function roleOptions(t: Translator, roles: readonly PlatformRole[]): SelectOption[] {
  return roles.map((role) => {
    const name = roleLabel(t, role);
    const count = t('identity.members.role.permission-count', { count: role.permissionCount });
    const base = `${name} · ${count}`;
    return role.grantable
      ? { value: role.roleId, label: base }
      : {
          value: role.roleId,
          label: `${base} · ${t('identity.members.role.not-grantable')}`,
          disabled: true,
        };
  });
}
