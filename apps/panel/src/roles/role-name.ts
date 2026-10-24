import { roleLabel, type RoleTranslator } from '../team/role-label.ts';
import type { RoleRecord } from './types.ts';

/** A role's display name: a custom role by its own name, a seeded role by its seed code. */
export function roleName(t: RoleTranslator, role: RoleRecord): string {
  if (role.kind === 'custom' && role.name !== null && role.name.trim() !== '') return role.name;
  return roleLabel(t, role);
}

/** "admin-account" becomes "Admin account": a label for a resource without a copy key. */
export function humanise(part: string): string {
  const text = part.replace(/[-_]+/g, ' ').trim();
  return text === '' ? part : text.charAt(0).toUpperCase() + text.slice(1);
}

/** The resource a permission key belongs to: its first two parts, e.g. `identity.admin-account`. */
export function resourceOf(key: string): string {
  return key.split('.').slice(0, 2).join('.');
}

/** Permission keys grouped by resource, both sorted, for one card per resource (ux B3). */
export function groupByResource(keys: readonly string[]): [string, string[]][] {
  const groups = new Map<string, string[]>();
  for (const key of [...keys].sort()) {
    const resource = resourceOf(key);
    const list = groups.get(resource);
    if (list === undefined) groups.set(resource, [key]);
    else list.push(key);
  }
  return [...groups.entries()];
}
