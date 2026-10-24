import type { TeamRole } from './types.ts';

/** The part of a translator the role label needs; server and client translators both fit. */
export interface RoleTranslator {
  (key: string): string;
  has(key: string): boolean;
}

/**
 * A role's label (ux 5): a seeded role by its seed code, a custom role generic until the API
 * returns names (slice 10), a seed code without a copy key "Role", never the raw code.
 */
export function roleLabel(t: RoleTranslator, role: TeamRole | null, scope = 'identity'): string {
  if (role === null) return t(`${scope}.members.role.none`);
  const key = `${scope}.role.${role.seedCode ?? ''}`;
  if (role.seedCode !== null && t.has(key)) return t(key);
  return role.kind === 'custom'
    ? t(`${scope}.members.role.custom`)
    : t(`${scope}.members.role.unknown`);
}
