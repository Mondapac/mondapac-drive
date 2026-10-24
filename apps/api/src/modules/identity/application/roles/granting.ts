import { err, ok } from '@mondapac-drive/shared-kernel';
import type { Id, MarketContext, Population, Result } from '@mondapac-drive/shared-kernel';
import type { SealedPermissionCatalogue } from '../../../../platform/authz';
import { ADMIN_ACCOUNT_INVITE } from '../../contracts/permissions';
import {
  GrantPolicy,
  type ActedOnAccount,
  type GrantedRole,
  type GrantingActor,
  type NotGrantable,
  type ProtectedKeyCatalogue,
} from '../../domain/grant-policy';
import { scopeOfPopulation, type Role, type RoleScope } from '../../domain/role';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { AccountRepository } from '../ports/account.repository';
import type { RoleGrantReader } from '../ports/role-grant-reader';

const POPULATION_OF_SCOPE: Readonly<Record<RoleScope, Population>> = Object.freeze({
  platform: 'admin',
  merchant: 'merchant',
  courier: 'courier',
});

/** An account whose grant is read: who it is, as the actor context or the store says. */
export interface GrantSubject {
  readonly accountId: Id<'Account'>;
  readonly population: Population;
}

/** What `GrantPolicy` reads of the actor and of the accounts it acts on, read in one unit. */
export interface GrantReading {
  readonly actor: GrantingActor;
  readonly targets: ReadonlyMap<Id<'Account'>, ActedOnAccount>;
}

/**
 * The grant read of every use case that applies `GrantPolicy` (identity design 5.4, 5.5; slices
 * 8a-2 and 8b; Hassan I-2 on slice 8a-1). It runs **in the caller's unit**, the one that then
 * writes, so the actor's role id, whether that role is the system role of its scope, and the
 * effective keys of the actor and of each target all come from one read of committed state,
 * never from the gate's earlier read-only unit or from the actor summary. Effective keys come
 * from the one resolver of the process (`EFFECTIVE_KEY_RESOLVER`), so the policy and the gate
 * cannot disagree on what a role confers.
 *
 * The actor's `scope` is its population's (R2); an actor without an assignment holds no key and
 * no role.
 */
export async function readGrants(
  grants: RoleGrantReader,
  resolve: EffectiveKeyResolver,
  market: MarketContext,
  actor: GrantSubject,
  targets: readonly GrantSubject[],
): Promise<GrantReading | null> {
  const actorScope = scopeOfPopulation(actor.population);
  const read = await grants.grantsOf(market, [
    actor.accountId,
    ...targets.map((target) => target.accountId),
  ]);
  const actorGrant = read.get(actor.accountId) ?? null;
  const actorKeys = resolve({ ...actor, grant: actorGrant });
  const actorView: GrantingActor = {
    accountId: actor.accountId,
    scope: actorScope,
    roleId: actorGrant?.roleId ?? null,
    // The system role counts only in the actor's own scope (R2).
    holdsSystemRole: actorGrant?.kind === 'system' && actorGrant.scope === actorScope,
    effectiveKeys: actorKeys,
  };
  const targetViews = new Map<Id<'Account'>, ActedOnAccount>();
  for (const target of targets) {
    targetViews.set(target.accountId, {
      accountId: target.accountId,
      scope: scopeOfPopulation(target.population),
      effectiveKeys: resolve({ ...target, grant: read.get(target.accountId) ?? null }),
    });
  }
  return { actor: actorView, targets: targetViews };
}

/**
 * The role as `GrantPolicy.canGrant` sees it: what it would confer (identity design 5.5). Its
 * keys are resolved as for a holder of the role in its own scope, so a system role means every key of its scope and a default or custom role its stored keys that
 * the registry still declares (R3, R7).
 */
export function grantedRoleOf(role: Role, resolve: EffectiveKeyResolver): GrantedRole {
  const { id, scope, kind, permissionKeys } = role.state;
  const effectiveKeys = resolve({
    population: POPULATION_OF_SCOPE[scope],
    accountId: id as unknown as Id<'Account'>,
    grant: { roleId: id, kind, scope, storedKeys: permissionKeys },
  });
  return { id, scope, kind, effectiveKeys };
}

/**
 * Hassan I-2 on slice 8a-1: before `canGrant`, a caller checks that the role is of the actor's
 * own scope (R2). Answers whether the role may be considered at all; a role that fails is
 * answered as unknown, byte-identical to a missing one (5.2).
 */
export function roleIsInActorsReach(role: Role, actor: GrantSubject): boolean {
  return role.state.scope === scopeOfPopulation(actor.population);
}

/** Which keys are protected (R11), from the sealed permission registry. */
export function protectedKeysOf(
  registry: Pick<SealedPermissionCatalogue, 'get'>,
): ProtectedKeyCatalogue {
  return { isProtected: (key) => registry.get(key)?.protected === true };
}

/** The ports {@link roleGrantVerdict} reads: the one resolver and the sealed registry. */
export interface RoleGrantDependencies {
  readonly effectiveKeys: EffectiveKeyResolver;
  readonly permissions: Pick<SealedPermissionCatalogue, 'get'>;
}

/**
 * Whether `actor` may put `role` in place (identity design 5.5): `GrantPolicy.canGrant` on what
 * the role confers ({@link grantedRoleOf}) with the registry's protected keys. The one grant
 * check of `AssignAdminRole`, `InviteAdmin`, the re-send and acceptance checks and the role
 * catalogue's `grantable` (slice 10a), so a hint and a command can never disagree on it.
 */
export function roleGrantVerdict(
  actor: GrantingActor,
  role: Role,
  deps: RoleGrantDependencies,
): Result<void, NotGrantable> {
  return GrantPolicy.canGrant(
    actor,
    grantedRoleOf(role, deps.effectiveKeys),
    protectedKeysOf(deps.permissions),
  );
}

/** The ports {@link readActingGrants} and {@link inviterMayStillGrant} read. */
export interface ActingGrantDependencies {
  readonly accounts: AccountRepository;
  readonly grants: RoleGrantReader;
  readonly effectiveKeys: EffectiveKeyResolver;
}

/**
 * The actor re-checked **in the unit that writes** (Mohammad C1, Hassan I1 on PR #187). The
 * gate checks in an earlier unit, so a disable or a demotion of the actor can commit in between.
 * The actor must still be an account of its population in this Market, `active`, with a
 * verified email, and its effective keys, read in this unit, must hold every key of
 * `requiredKeys` (the use case's rule). Then the grants of the actor and of `targets`, as
 * {@link readGrants}. Null: the caller answers `access.denied`.
 */
export async function readActingGrants(
  deps: ActingGrantDependencies,
  market: MarketContext,
  actor: GrantSubject,
  targets: readonly GrantSubject[],
  requiredKeys: readonly string[],
): Promise<GrantReading | null> {
  const account = await deps.accounts.findById(market, actor.accountId);
  if (
    account === null ||
    account.state.population !== actor.population ||
    account.state.status !== 'active' ||
    !account.isEmailVerified
  ) {
    return null;
  }
  const reading = await readGrants(deps.grants, deps.effectiveKeys, market, actor, targets);
  if (reading === null) return null;
  return requiredKeys.every((key) => reading.actor.effectiveKeys.has(key)) ? reading : null;
}

/** Why an invitation's inviter no longer stands behind it (logged, never answered). */
export type InviterRefusal = 'inviter-inactive' | 'inviter-cannot-grant';

/**
 * Whether the inviter of an admin invitation could still issue it now (identity design 3.4;
 * Hassan 14.2): an active, verified admin of this Market who holds
 * `identity.admin-account.invite` and passes `GrantPolicy.canGrant` for the role, all read in
 * the caller's unit. The acceptance's closing unit calls it, and so does a re-send (Hassan L3 on
 * PR #187): an invitation its inviter could no longer issue can never be accepted, so it is not
 * sent again either.
 */
export async function inviterMayStillGrant(
  deps: ActingGrantDependencies & {
    readonly permissions: Pick<SealedPermissionCatalogue, 'get'>;
  },
  market: MarketContext,
  inviterId: Id<'Account'>,
  role: Role,
): Promise<Result<void, InviterRefusal>> {
  const reading = await readActingGrants(
    deps,
    market,
    { accountId: inviterId, population: 'admin' },
    [],
    [ADMIN_ACCOUNT_INVITE.key],
  );
  if (reading === null) return err('inviter-inactive');
  const granted = roleGrantVerdict(reading.actor, role, deps);
  return granted.ok ? ok(undefined) : err('inviter-cannot-grant');
}
