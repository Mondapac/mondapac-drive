import type { SealedPermissionCatalogue } from '../../../../platform/authz';
import { MAX_SEED_KEYS_PER_ROW } from '../../domain/audit';
import { fitsSeedKeysBudget } from './role-seed-budget';
import type { SeededRole } from '../ports/role-seed';

/** Why the seed's keys disagree with the registry (identity design 5.6). */
export type RoleSeedKeyProblem =
  | 'unknown-key'
  | 'wrong-scope'
  | 'protected-key'
  | 'system-keys'
  | 'too-many-keys'
  | 'keys-too-large';

/** A seed whose keys disagree with the permission registry: fails boot and the seed run. */
export class RoleSeedKeyError extends Error {
  override readonly name = 'RoleSeedKeyError';
  constructor(
    readonly problem: RoleSeedKeyProblem,
    readonly seedCode: string,
    readonly key: string | null,
  ) {
    super(`Role seed "${seedCode}": ${problem}${key === null ? '' : ` (${key})`}`);
  }
}

/**
 * The key half of the seed check (identity design 5.6): "a test and each boot fail when a seed
 * key is unknown to the registry, in the wrong scope or protected". A system role lists no key
 * (R3). A default role lists only keys the registry declares in the role's own scope (R2, R7)
 * and none that is protected (R11: no default role can hand a protected key to anyone), and at
 * most `MAX_SEED_KEYS_PER_ROW`, within the byte budget of `role-seed-budget.ts` (two separate
 * checks), so that its `seed-applied` row fits the audit writer. Run at
 * boot once the registry is sealed (`PermissionRegistry.whenSealed`) and again by every seed
 * run, so a seed that disagrees is never applied.
 */
export function checkRoleSeedKeys(
  roles: readonly SeededRole[],
  catalogue: Pick<SealedPermissionCatalogue, 'get'>,
): void {
  for (const role of roles) {
    if (role.kind === 'system') {
      if (role.permissionKeys.length > 0) {
        throw new RoleSeedKeyError('system-keys', role.seedCode, null);
      }
      continue;
    }
    if (role.permissionKeys.length > MAX_SEED_KEYS_PER_ROW) {
      throw new RoleSeedKeyError('too-many-keys', role.seedCode, null);
    }
    if (!fitsSeedKeysBudget(role.permissionKeys)) {
      throw new RoleSeedKeyError('keys-too-large', role.seedCode, null);
    }
    for (const key of role.permissionKeys) {
      const declaration = catalogue.get(key);
      if (declaration === undefined) throw new RoleSeedKeyError('unknown-key', role.seedCode, key);
      if (declaration.scope !== role.scope) {
        throw new RoleSeedKeyError('wrong-scope', role.seedCode, key);
      }
      if (declaration.protected) throw new RoleSeedKeyError('protected-key', role.seedCode, key);
    }
  }
}
