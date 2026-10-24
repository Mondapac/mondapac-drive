import type { RoleScope } from '../../domain/role';

/**
 * One role of the checked-in seed (identity design 5.6): a stable code, a translation key for
 * its name and its keys. A system role holds every key of its scope by definition (R3), so its
 * list is empty; a default role (slice 8a-1) lists its keys, each declared in its scope and
 * never protected. A change of a role's entry raises its `seedVersion`, and the seed routine
 * applies the newer version with an audit row (Ali 2026-10-08).
 */
export interface SeededRole {
  readonly scope: RoleScope;
  readonly kind: 'system' | 'default';
  readonly seedCode: string;
  readonly seedVersion: number;
  /** The translation key of the role's name: never stored, never in an event. */
  readonly nameKey: string;
  readonly permissionKeys: readonly string[];
}

/** The seed of every scope, read by the seed routine (5.6). */
export interface RoleSeed {
  roles(): readonly SeededRole[];
}

/** Nest token of the {@link RoleSeed}. */
export const ROLE_SEED = Symbol('ROLE_SEED');
