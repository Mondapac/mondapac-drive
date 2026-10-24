import type { Id } from '@mondapac-drive/shared-kernel';
import type { SealedPermissionCatalogue } from '../../../../platform/authz';
import type { GrantingActor } from '../../domain/grant-policy';
import type { Role, RoleKind, RoleScope } from '../../domain/role';
import { roleGrantVerdict, type GrantSubject, roleIsInActorsReach } from './granting';
import type { RoleGrantDependencies } from './granting';
import {
  conferredKeysOf,
  customRoleGrantVerdict,
  roleDeleteVerdict,
  roleEditVerdict,
} from './role-editing';

// The role catalogue of both scopes (identity design 5.3, 8.6 row 6; slices 10a and 10): one
// builder, so the platform read (`identity.platform-role.view`) and the seller read
// (`identity.seller-role.view`) answer the same shape from the same verdict functions as the
// commands. Hints are advisory: every command checks again in its own unit.

/** `{allowed, code}` per row and action (8.6 row 6), as the team list (slice 8c) gives it. */
export type RoleActionHint =
  | { readonly allowed: true; readonly code: null }
  | { readonly allowed: false; readonly code: string };

const ALLOWED: RoleActionHint = Object.freeze({ allowed: true, code: null });
const denied = (code: string): RoleActionHint => Object.freeze({ allowed: false, code });

/** One role of the catalogue. */
export interface RoleEntry {
  readonly roleId: Id<'Role'>;
  /** `system` gets a lock in the panel; `custom` is the only kind with a name and an editor. */
  readonly kind: RoleKind;
  /** The seed code of a system or default role (its label is a translation key); else null. */
  readonly seedCode: string | null;
  /** The name of a custom role (personal free text); null for a seeded role. */
  readonly name: string | null;
  /** How many keys the role confers now: every key of the scope for the system role (R3). */
  readonly permissionCount: number;
  /** The keys it confers now, sorted: all keys of the scope for the system role (R3, R7). */
  readonly permissionKeys: readonly string[];
  /**
   * Whether this actor may give this role now (`roleGrantVerdict`, the check of the assign and
   * invite commands). It says nothing about whether the actor holds those permissions.
   */
  readonly grantable: boolean;
  /** The aggregate version: changes with every edit. */
  readonly version: number;
  /** The editor's actions on this role; `access.denied` where the actor lacks the key. */
  readonly actions: { readonly edit: RoleActionHint; readonly delete: RoleActionHint };
}

/** One permission key of the scope, with whether this actor may put it in a custom role. */
export interface RoleKeyEntry {
  readonly key: string;
  readonly protected: boolean;
  /** `customRoleGrantVerdict` for this one key: the create command's own check (R1, R11). */
  readonly grantable: boolean;
}

export interface RoleCatalogue {
  readonly items: readonly RoleEntry[];
  /** Every key the registry declares in the scope, by key. */
  readonly keys: readonly RoleKeyEntry[];
}

export interface RoleCatalogueInput {
  readonly scope: RoleScope;
  readonly actor: GrantingActor;
  readonly subject: GrantSubject;
  readonly roles: readonly Role[];
  readonly held: ReadonlySet<Id<'Role'>>;
  readonly editKey: string;
  readonly deleteKey: string;
  readonly deps: RoleGrantDependencies & {
    readonly permissions: Pick<SealedPermissionCatalogue, 'get' | 'list'>;
  };
}

/**
 * The catalogue for one actor. Each role is checked to be in the actor's reach (a row that is
 * not a role of the actor's scope, or is another seller's, is never shown). `held` is read once
 * for the whole page by the caller.
 */
export function buildRoleCatalogue(input: RoleCatalogueInput): RoleCatalogue {
  const { scope, actor, subject, roles, held, editKey, deleteKey, deps } = input;
  const mayEdit = actor.effectiveKeys.has(editKey);
  const mayDelete = actor.effectiveKeys.has(deleteKey);
  const items = roles
    .filter((role) => role.state.scope === scope && roleIsInActorsReach(role, subject))
    .map((role): RoleEntry => {
      const permissionKeys = conferredKeysOf(role, deps);
      return {
        roleId: role.state.id,
        kind: role.state.kind,
        seedCode: role.state.seedCode,
        name: role.state.kind === 'custom' ? (role.state.name ?? null) : null,
        permissionCount: permissionKeys.length,
        permissionKeys,
        grantable: roleGrantVerdict(actor, role, deps).ok,
        version: role.state.version,
        actions: {
          edit: !mayEdit ? denied('access.denied') : hintOf(roleEditVerdict(actor, role, deps)),
          delete: !mayDelete
            ? denied('access.denied')
            : hintOf(roleDeleteVerdict(actor, role, held.has(role.state.id), deps)),
        },
      };
    });
  const probeId = actor.accountId as unknown as Id<'Role'>;
  const keys = deps.permissions
    .list(scope)
    .map((declaration): RoleKeyEntry => ({
      key: declaration.key,
      protected: declaration.protected,
      grantable: customRoleGrantVerdict(actor, scope, [declaration.key], deps, probeId).ok,
    }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { items, keys };
}

function hintOf(result: { readonly ok: boolean; readonly error?: { readonly code: string } }) {
  return result.ok ? ALLOWED : denied(result.error!.code);
}
