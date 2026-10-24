import { err, ok } from '@mondapac-drive/shared-kernel';
import type { Id, Result } from '@mondapac-drive/shared-kernel';
import type { SealedPermissionCatalogue } from '../../../../platform/authz';
import { MAX_CUSTOM_ROLE_KEYS } from '../../domain/audit';
import {
  GrantPolicy,
  type GrantedRole,
  type GrantingActor,
  type NotGrantable,
} from '../../domain/grant-policy';
import type { Role, RoleScope } from '../../domain/role';
import {
  grantedRoleOf,
  protectedKeysOf,
  roleGrantVerdict,
  type RoleGrantDependencies,
} from './granting';
import { SEED_KEYS_BUDGET_BYTES, seedKeysCost } from './role-seed-budget';

// The verdicts and the key check of the role editor (identity design 5.3 `.role.create`, `.edit`,
// `.delete`, 5.4 R1, R2, R7, R10, R11; slice 10). The create, edit and delete commands and the
// catalogue's hints (`grantable` per key, `actions` per role) call these same functions, so a
// hint and a command cannot disagree; each command also checks again in its own unit.

/** A refusal of the key list: a code per kind, never a key (the list is the caller's input). */
export type RoleKeysInvalid = {
  readonly code: 'validation.failed';
  readonly fields: readonly { readonly path: 'permissionKeys'; readonly code: string }[];
};

/** Raw lists longer than this are refused before any element is looked at. */
const MAX_RAW_KEYS = 256;

/**
 * The keys of a custom role as the command takes them (R2, R7): an array of strings, each a key
 * the registry declares **in the role's scope**, none twice, at most {@link MAX_CUSTOM_ROLE_KEYS}
 * and within the byte budget of one audit row. Codes: `format` (not an array of strings),
 * `unknown` (not declared), `scope` (declared for the other scope), `duplicate`, `too-many`.
 * The list is sorted and returned frozen; an empty list is allowed.
 */
export function parseRoleKeys(
  raw: unknown,
  scope: RoleScope,
  registry: Pick<SealedPermissionCatalogue, 'get'>,
): Result<readonly string[], RoleKeysInvalid> {
  const refuse = (code: string): Result<never, RoleKeysInvalid> =>
    err({ code: 'validation.failed', fields: [{ path: 'permissionKeys', code }] });
  if (!Array.isArray(raw)) return refuse('format');
  if (raw.length > MAX_RAW_KEYS) return refuse('too-many');
  const codes = new Set<string>();
  const seen = new Set<string>();
  for (const key of raw as unknown[]) {
    if (typeof key !== 'string') return refuse('format');
    const declaration = registry.get(key);
    if (declaration === undefined) codes.add('unknown');
    else if (declaration.scope !== scope) codes.add('scope');
    if (seen.has(key)) codes.add('duplicate');
    seen.add(key);
  }
  if (codes.size > 0) {
    return err({
      code: 'validation.failed',
      fields: [...codes].sort().map((code) => ({ path: 'permissionKeys' as const, code })),
    });
  }
  const keys = [...seen].sort();
  if (keys.length > MAX_CUSTOM_ROLE_KEYS || seedKeysCost(keys) > SEED_KEYS_BUDGET_BYTES) {
    return refuse('too-many');
  }
  return ok(Object.freeze(keys));
}

/**
 * Whether `actor` may put a custom role of `scope` that confers exactly `keys` in place (R1, R11
 * through `GrantPolicy.canGrant`): the create command's check, the edit command's check of the
 * **new** key set, and (one key at a time) the catalogue's `grantable` flag per key.
 */
export function customRoleGrantVerdict(
  actor: GrantingActor,
  scope: RoleScope,
  keys: readonly string[],
  deps: RoleGrantDependencies,
  roleId: Id<'Role'>,
): Result<void, NotGrantable> {
  // The probe is never stored: only its scope, kind and keys are read (`canGrant` compares an id
  // only for a system role).
  const probe: GrantedRole = { id: roleId, scope, kind: 'custom', effectiveKeys: new Set(keys) };
  return GrantPolicy.canGrant(actor, probe, protectedKeysOf(deps.permissions));
}

/** The refusals of an edit or a delete that a verdict can name (the commands add their own). */
export type RoleEditRefusal =
  | { readonly code: 'role.read-only' }
  | { readonly code: 'role.not-grantable'; readonly reason: NotGrantable['reason'] }
  | { readonly code: 'role.in-use' };

/**
 * Whether `actor` may edit this role at all: only a custom role has an edit path (R3, R9, R10;
 * `role.read-only`), and the actor must be able to grant the role as it stands now, so no one
 * edits a role that outranks it (R1, R11): `role.not-grantable`. The edit command then checks
 * the new key set with {@link customRoleGrantVerdict}.
 */
export function roleEditVerdict(
  actor: GrantingActor,
  role: Role,
  deps: RoleGrantDependencies,
): Result<void, RoleEditRefusal> {
  if (role.state.kind !== 'custom') return err({ code: 'role.read-only' });
  const granted = roleGrantVerdict(actor, role, deps);
  return granted.ok ? ok(undefined) : err(granted.error);
}

/**
 * Whether `actor` may delete this role: {@link roleEditVerdict}, then `role.in-use` while any
 * account holds it (identity design 2.3; the assignment foreign key is RESTRICT). Invitations
 * for a deleted role become unusable (R12) and do not block it.
 */
export function roleDeleteVerdict(
  actor: GrantingActor,
  role: Role,
  held: boolean,
  deps: RoleGrantDependencies,
): Result<void, RoleEditRefusal> {
  const editable = roleEditVerdict(actor, role, deps);
  if (!editable.ok) return editable;
  return held ? err({ code: 'role.in-use' }) : ok(undefined);
}

/** The keys a role confers now, sorted (R3, R7): the catalogue's key detail. */
export function conferredKeysOf(role: Role, deps: RoleGrantDependencies): readonly string[] {
  return [...grantedRoleOf(role, deps.effectiveKeys).effectiveKeys].sort();
}
