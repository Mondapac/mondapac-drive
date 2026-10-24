import { err, ok } from '@mondapac-drive/shared-kernel';
import type {
  Id,
  MarketContext,
  Population,
  Result,
  Temporal,
} from '@mondapac-drive/shared-kernel';
import type { SealedPermissionCatalogue } from '../../../../platform/authz';
import { statusChangeRefusal } from '../../domain/account';
import {
  GrantPolicy,
  type ActedOnAccount,
  type CannotActOn,
  type GrantingActor,
} from '../../domain/grant-policy';
import { invitationReissuableAt, type InvitationState } from '../../domain/invitation';
import { LastHolderPolicy, type LastHolder } from '../../domain/last-holder-policy';
import type { Role } from '../../domain/role';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { AccountRepository } from '../ports/account.repository';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import type { RoleRepository } from '../ports/role.repository';
import {
  inviterMayStillGrant,
  roleGrantVerdict,
  roleIsInActorsReach,
  type GrantSubject,
  type InviterRefusal,
} from '../roles/granting';

// The decisions the admin team commands take after their gate (slices 8a-2, 8b), each in one
// function, so the commands and the admin team list's per-row hints (slice 8c; identity design
// 8.6 row 6) run the same code: the hints are never a second implementation (Ali's ruling on
// 8c; Hassan). A function here reads only what its caller passes or the ports it is given; the
// caller decides the unit (the command's serializable one, the list's read-only one).

/** Whether `roleId` is the platform system role (`systemRoleId` null: the seed has not run). */
export function isSystemRole(roleId: Id<'Role'> | null, systemRoleId: Id<'Role'> | null): boolean {
  return systemRoleId !== null && roleId === systemRoleId;
}

/**
 * Whether `actor` may act on the admin `target` at all (identity design 5.4 R1, R3, 5.5):
 * `GrantPolicy.canActOn` (never oneself; the target's keys a subset of the actor's), then R3 on
 * the target: acting on a holder of the Platform Administrator role needs that same role. A
 * customer target (no role) is decided by `canActOn` alone (`targetRoleId` null).
 */
export function mayActOnAdmin(
  actor: GrantingActor,
  target: ActedOnAccount,
  targetRoleId: Id<'Role'> | null,
  systemRoleId: Id<'Role'> | null,
): Result<void, CannotActOn> {
  const acted = GrantPolicy.canActOn(actor, target);
  if (!acted.ok) return acted;
  if (
    isSystemRole(targetRoleId, systemRoleId) &&
    !(actor.holdsSystemRole && actor.roleId === systemRoleId)
  ) {
    return err({ code: 'member.outranks-actor' });
  }
  return ok(undefined);
}

export type StatusChangeVerdictRefusal =
  | CannotActOn
  | LastHolder
  | { readonly code: 'account.unknown' }
  | { readonly code: 'account.already-disabled' }
  | { readonly code: 'account.already-active' };

/**
 * The guards of a disable or an enable after the actor and the account are read (identity
 * design 3.1; slice 8b): {@link mayActOnAdmin}; for a disable of a holder of the Platform
 * Administrator role, `LastHolderPolicy` over the holders `holders` reads (only then, so a
 * command counts in its own unit and only when it must); then `statusChangeRefusal`. A
 * seller-side account answers `account.unknown`, as a missing one (3.1).
 */
export async function statusChangeVerdict(input: {
  readonly actor: GrantingActor;
  readonly target: ActedOnAccount;
  readonly population: Population;
  readonly status: 'active' | 'disabled';
  readonly to: 'active' | 'disabled';
  /** The target's role; null for a customer. */
  readonly targetRoleId: Id<'Role'> | null;
  readonly systemRoleId: Id<'Role'> | null;
  readonly holders: () => Promise<readonly Id<'Account'>[]>;
}): Promise<Result<void, StatusChangeVerdictRefusal>> {
  const acted = mayActOnAdmin(input.actor, input.target, input.targetRoleId, input.systemRoleId);
  if (!acted.ok) return acted;
  if (input.to === 'disabled' && isSystemRole(input.targetRoleId, input.systemRoleId)) {
    const kept = LastHolderPolicy.allowsLosing(await input.holders(), input.target.accountId);
    if (!kept.ok) return kept;
  }
  const refused = statusChangeRefusal(input.population, input.status, input.to);
  if (refused === null) return ok(undefined);
  return err(refused.code === 'account.not-eligible' ? { code: 'account.unknown' } : refused);
}

/**
 * The guards of resetting another admin's second factor after the actor and the account are
 * read (identity design 3.6, 7.3; slice 8b): {@link mayActOnAdmin}, then a factor must exist
 * (`second-factor.none`). `factorExists` is asked only when the first passes.
 */
export async function secondFactorResetVerdict(input: {
  readonly actor: GrantingActor;
  readonly target: ActedOnAccount;
  readonly targetRoleId: Id<'Role'> | null;
  readonly systemRoleId: Id<'Role'> | null;
  readonly factorExists: () => Promise<boolean>;
}): Promise<Result<void, CannotActOn | { readonly code: 'second-factor.none' }>> {
  const acted = mayActOnAdmin(input.actor, input.target, input.targetRoleId, input.systemRoleId);
  if (!acted.ok) return acted;
  return (await input.factorExists()) ? ok(undefined) : err({ code: 'second-factor.none' });
}

/** The ports {@link adminInvitationResendVerdict} reads. */
export interface ResendVerdictDependencies {
  readonly accounts: AccountRepository;
  readonly roles: RoleRepository;
  readonly grants: RoleGrantReader;
  readonly effectiveKeys: EffectiveKeyResolver;
  readonly permissions: Pick<SealedPermissionCatalogue, 'get'>;
}

export type ResendVerdictRefusal =
  | { readonly code: 'invitation.rejected'; readonly inviterRefusal?: InviterRefusal }
  | { readonly code: 'role.not-grantable' };

/**
 * The guards of re-sending an admin invitation once it is found (identity design 3.4; slice 8b,
 * PR #187 round 1): never a first-admin invitation or a decided one (Mohammad Q4); its role still
 * a platform role in the actor's reach (R12); `GrantPolicy.canGrant` for the actor
 * (`role.not-grantable`); its inviter could still issue it (Hassan L3; `inviterRefusal` is for
 * the log only); and before `createdAt` plus the kind's lifetime (Mohammad C2). It reads only the
 * fields named, so a summary without the token hash serves as well as the aggregate's state.
 * Answers the role.
 */
export async function adminInvitationResendVerdict(
  deps: ResendVerdictDependencies,
  market: MarketContext,
  actor: { readonly self: GrantSubject; readonly view: GrantingActor },
  invitation: Pick<InvitationState, 'invitedByAccountId' | 'state' | 'roleId' | 'createdAt'>,
  now: Temporal.Instant,
  lifetimeMinutes: number,
): Promise<Result<Role, ResendVerdictRefusal>> {
  const inviterId = invitation.invitedByAccountId;
  if (inviterId === null || invitation.state !== 'pending') {
    return err({ code: 'invitation.rejected' });
  }
  const role = await deps.roles.findById(market, invitation.roleId);
  if (role === null || !roleIsInActorsReach(role, actor.self)) {
    return err({ code: 'invitation.rejected' });
  }
  const granted = roleGrantVerdict(actor.view, role, deps);
  if (!granted.ok) return err({ code: 'role.not-grantable' });
  const inviter = await inviterMayStillGrant(deps, market, inviterId, role);
  if (!inviter.ok) return err({ code: 'invitation.rejected', inviterRefusal: inviter.error });
  if (!invitationReissuableAt(invitation, now, lifetimeMinutes)) {
    return err({ code: 'invitation.rejected' });
  }
  return ok(role);
}
