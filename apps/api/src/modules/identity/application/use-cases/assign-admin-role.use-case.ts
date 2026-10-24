import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac-drive/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac-drive/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  UseCase,
  type AccessDeclaration,
  type SealedPermissionCatalogue,
  type UseCaseGate,
} from '../../../../platform/authz';
import { PLATFORM_ROLE_ASSIGN } from '../../contracts/permissions';
import { AccountRoleChangedAudit } from '../../domain/audit';
import { LastHolderPolicy } from '../../domain/last-holder-policy';
import { isSystemRole, mayActOnAdmin } from '../accounts/admin-verdicts';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { AccountRepository } from '../ports/account.repository';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import type { RoleAssignmentRepository, RoleRepository } from '../ports/role.repository';
import {
  readActingGrants,
  roleGrantVerdict,
  roleIsInActorsReach,
  type GrantSubject,
} from '../roles/granting';

const RULE_KEYS = [PLATFORM_ROLE_ASSIGN.key];

export interface AssignAdminRoleInput {
  readonly accountId: Id<'Account'>;
  readonly roleId: Id<'Role'>;
}

export interface AssignAdminRoleOutput {
  /** `role.assigned`, or `role.unchanged` when the account already held the role. */
  readonly code: 'role.assigned' | 'role.unchanged';
  readonly accountId: Id<'Account'>;
  readonly roleId: Id<'Role'>;
}

export type AssignAdminRoleFailure =
  /** No admin account with this id in the Market (also any other population): "not found". */
  | { readonly code: 'account.unknown' }
  /** No platform role with this id in the Market (also a seller's role): "not found". */
  | { readonly code: 'role.unknown' }
  | { readonly code: 'member.self' }
  | { readonly code: 'member.outranks-actor' }
  | { readonly code: 'role.not-grantable' }
  | { readonly code: 'member.last-holder' }
  | { readonly code: 'access.denied' };

export interface AssignAdminRoleDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly roles: RoleRepository;
  readonly assignments: RoleAssignmentRepository;
  readonly grants: RoleGrantReader;
  readonly effectiveKeys: EffectiveKeyResolver;
  readonly permissions: Pick<SealedPermissionCatalogue, 'get'>;
  readonly outbox: OutboxWriter;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

/**
 * Changes an admin's role (identity design 5.3 `identity.platform-role.assign`, 5.4 R1 and R3,
 * 5.5; AC 23, AC 25, AC 34; slice 8a-2, HF8). Rule `permissions [identity.platform-role.assign]`
 * (a protected key, R11): the gate has checked the key; everything else is decided here, in
 * **one serializable unit** (5.5, HF8; data design 5.1), so of two concurrent demotions of the
 * last two Platform Administrators one is retried and then refused:
 *
 * 0. The actor, read in this unit (`readActingGrants`; Mohammad C1, Hassan I1 on PR #187): still
 *    an active, verified admin holding `identity.platform-role.assign`, else `access.denied`.
 *    A disable or demotion of the actor that commits after the gate's check is seen here.
 * 1. The target is an admin account of the context Market; any other id answers
 *    `account.unknown`, and a role that is not a platform role of this Market `role.unknown`,
 *    byte-identical to a missing one (5.2; Hassan I-2: a seller's custom role is never in an
 *    admin's reach).
 * 2. The grants of the actor and the target are read in this unit (Hassan I-2), never taken from
 *    the gate's read or the actor summary.
 * 3. `GrantPolicy.canActOn`: not oneself (`member.self`); the target's keys are a subset of the
 *    actor's (R1). Changing the role of a holder of the system role needs that same role (R3,
 *    `member.outranks-actor`).
 * 4. `GrantPolicy.canGrant` on the new role: the actor holds every key it confers (R1), a
 *    protected key needs the system role (R11), the system role needs the actor to hold it (R3,
 *    AC 34); otherwise `role.not-grantable`.
 * 5. `LastHolderPolicy` when the target holds the Platform Administrator role and loses it: the
 *    active, verified holders are counted in this unit (`member.last-holder`, AC 25).
 * 6. The assignment changes under its version; `identity.account-role-changed.v1` and the audit
 *    row `identity.account-role.changed` (`before` and `after` role ids, R5).
 *
 * The same role answers `role.unchanged` and writes nothing. No session is revoked: permissions
 * are read on every request (R4, AC 26).
 */
export class AssignAdminRole extends UseCase<
  AssignAdminRoleInput,
  AssignAdminRoleOutput,
  AssignAdminRoleFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.assign-admin-role',
    rule: { kind: 'permissions', allOf: [PLATFORM_ROLE_ASSIGN.key] },
  };

  readonly #logger = new Logger('AssignAdminRole');

  constructor(
    gate: UseCaseGate,
    private readonly deps: AssignAdminRoleDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AssignAdminRoleInput,
  ): Promise<Result<AssignAdminRoleOutput, AssignAdminRoleFailure>> {
    const { market, actor } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const self: GrantSubject = { accountId: actor.accountId, population: 'admin' };
    const result = await this.deps.unitOfWork.run(
      market,
      async (): Promise<Result<AssignAdminRoleOutput, AssignAdminRoleFailure>> => {
        const now = this.deps.clock.now();
        const subject: GrantSubject = {
          accountId: input.accountId,
          population: 'admin',
        };
        // C1: the actor is still an active admin holding the rule's key, read in this unit.
        const reading = await readActingGrants(this.deps, market, self, [subject], RULE_KEYS);
        if (reading === null) return err({ code: 'access.denied' });
        const target = await this.deps.accounts.findById(market, input.accountId);
        if (target === null || target.state.population !== 'admin') {
          return err({ code: 'account.unknown' });
        }
        const role = await this.deps.roles.findById(market, input.roleId);
        if (role === null || !roleIsInActorsReach(role, self)) {
          return err({ code: 'role.unknown' });
        }
        const assignment = await this.deps.assignments.findByAccount(market, subject.accountId);
        const system = await this.deps.roles.findSystemRole(market, 'platform');
        const systemRoleId = system?.state.id ?? null;
        // canActOn, then R3 on the target: the one check of the command and of the list's hint
        // (slice 8c). Without an assignment R3 cannot apply, so the order of 8a-2 is kept.
        // Mirror: `changeRoleHint` in list-admin-team.use-case.ts (the target-dependent steps
        // here, through `LastHolderPolicy` below); change both together (Mohammad, PR #196).
        const acted = mayActOnAdmin(
          reading.actor,
          reading.targets.get(subject.accountId)!,
          assignment?.state.roleId ?? null,
          systemRoleId,
        );
        if (!acted.ok) return err(acted.error);
        if (assignment === null) {
          // Every admin account is created with its assignment (acceptance, 3.4); one without is
          // a corrupt store, answered as not found and logged, never repaired here.
          this.log('identity.assign-admin-role.assignment-missing', context, {
            accountId: subject.accountId,
          });
          return err({ code: 'account.unknown' });
        }
        const holdsSystem = isSystemRole(assignment.state.roleId, systemRoleId);
        const granted = roleGrantVerdict(reading.actor, role, this.deps);
        if (!granted.ok) {
          this.log('identity.assign-admin-role.not-grantable', context, {
            reason: granted.error.reason,
          });
          return err({ code: 'role.not-grantable' });
        }
        const previousRoleId = assignment.state.roleId;
        if (previousRoleId === role.state.id) {
          return ok({
            code: 'role.unchanged',
            accountId: subject.accountId,
            roleId: role.state.id,
          });
        }
        if (holdsSystem) {
          const holders = await this.deps.assignments.activeHoldersOf(market, systemRoleId!);
          const kept = LastHolderPolicy.allowsLosing(holders, subject.accountId);
          if (!kept.ok) return err(kept.error);
        }
        assignment.reassign({
          account: { id: subject.accountId, marketId: market.marketId, population: 'admin' },
          role,
          assignedBy: actor.accountId,
          now,
        });
        await this.deps.assignments.save(market, assignment);
        await this.deps.outbox.append(context, assignment.pendingEvents);
        await this.deps.audit.record(
          context,
          AccountRoleChangedAudit.entry(subject.accountId, {
            before: { roleId: previousRoleId },
            after: { roleId: role.state.id, scope: 'platform' },
          }),
        );
        return ok({ code: 'role.assigned', accountId: subject.accountId, roleId: role.state.id });
      },
      { isolation: 'serializable' },
    );
    this.log('identity.assign-admin-role', context, {
      outcome: result.ok ? result.value.code : result.error.code,
      accountId: input.accountId,
      ...(result.ok ? { roleId: result.value.roleId } : {}),
    });
    return result;
  }

  /** Ids and codes only: never a name, an email or a role's name (R5). */
  private log(msg: string, context: CallContext, fields: Record<string, string>): void {
    this.#logger.log({
      msg,
      ...fields,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}
