import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac-drive/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac-drive/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ADMIN_ACCOUNT_RESET_SECOND_FACTOR } from '../../contracts/permissions';
import { SecondFactorResetAudit } from '../../domain/audit';
import type { SecondFactor } from '../../domain/second-factor';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { AccountRepository } from '../ports/account.repository';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import type { SecondFactorRepository } from '../ports/second-factor.repository';
import type { RoleAssignmentRepository, RoleRepository } from '../ports/role.repository';
import type { SessionRepository } from '../ports/session.repository';
import type { SignInChallengeRepository } from '../ports/sign-in-challenge.repository';
import { secondFactorResetVerdict } from '../accounts/admin-verdicts';
import { readActingGrants, type GrantSubject } from '../roles/granting';

const RULE_KEYS = [ADMIN_ACCOUNT_RESET_SECOND_FACTOR.key];

export interface ResetOtherAdminSecondFactorInput {
  readonly accountId: Id<'Account'>;
}

export interface ResetOtherAdminSecondFactorOutput {
  readonly code: 'second-factor.reset';
  readonly accountId: Id<'Account'>;
  readonly revokedSessions: number;
}

export type ResetOtherAdminSecondFactorFailure =
  /** No admin account with this id in the Market: "not found" (5.2). */
  | { readonly code: 'account.unknown' }
  /** The account has no factor: nothing to reset (its next sign-in mails an enrolment link). */
  | { readonly code: 'second-factor.none' }
  | { readonly code: 'member.self' }
  | { readonly code: 'member.outranks-actor' }
  | { readonly code: 'access.denied' };

export interface ResetOtherAdminSecondFactorDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly roles: RoleRepository;
  readonly assignments: RoleAssignmentRepository;
  readonly grants: RoleGrantReader;
  readonly effectiveKeys: EffectiveKeyResolver;
  readonly factors: SecondFactorRepository;
  readonly sessions: SessionRepository;
  readonly challenges: SignInChallengeRepository;
  readonly outbox: OutboxWriter;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

/**
 * Resets another admin's second factor (identity design 3.6 `active` → `none`, 7.3 "Admin" row;
 * AC 18, AC 33; slice 8b). Rule `permissions [identity.admin-account.reset-second-factor]`
 * (protected, R11). The authenticated counterpart of the operator's break-glass
 * (`ResetAdminSecondFactor`, 7.4), which stays the way for the last Platform Administrator.
 *
 * One serializable unit: the account's credential lock first, as every unit that ends sessions
 * takes it (6.3, HF11); the actor, still an active, verified admin holding the rule's key, read
 * in this unit (Mohammad C1 on PR #187; else `access.denied`); the target, an admin of the
 * context Market, else `account.unknown`; the
 * grants of both read in this unit (Hassan I-2); `GrantPolicy.canActOn`: never one's own factor
 * through this path (`member.self`, 3.6 "forbidden"), never an admin who holds a key the actor
 * lacks (R1, AC 33), and a holder of the Platform Administrator role only by a holder (R3). Then
 * the factor's last version step, its removal with its recovery codes, **every session revoked**
 * (`second-factor-reset`), **every open challenge void**, `second-factor-changed` (`reset`, which
 * mails the account) and `identity.second-factor.reset` as the actor. The `second-factor.account`
 * counter is never touched (6.8, Hassan I-4). The admin's next sign-in mails an enrolment link
 * (HF6), so no session opens before a new enrolment.
 *
 * SEL-08 (identity design 6.7, Hassan I2 (c)): when Login-as-Seller lands, this reset must also
 * end the target admin's acting-as sessions in this unit.
 */
export class ResetOtherAdminSecondFactor extends UseCase<
  ResetOtherAdminSecondFactorInput,
  ResetOtherAdminSecondFactorOutput,
  ResetOtherAdminSecondFactorFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.reset-other-admin-second-factor',
    rule: { kind: 'permissions', allOf: [ADMIN_ACCOUNT_RESET_SECOND_FACTOR.key] },
  };

  readonly #logger = new Logger('ResetOtherAdminSecondFactor');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ResetOtherAdminSecondFactorDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ResetOtherAdminSecondFactorInput,
  ): Promise<Result<ResetOtherAdminSecondFactorOutput, ResetOtherAdminSecondFactorFailure>> {
    const { market, actor } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const self: GrantSubject = { accountId: actor.accountId, population: 'admin' };
    const result = await this.deps.unitOfWork.run(
      market,
      async (): Promise<
        Result<ResetOtherAdminSecondFactorOutput, ResetOtherAdminSecondFactorFailure>
      > => {
        const now = this.deps.clock.now();
        if (!(await this.deps.accounts.lockCredential(market, input.accountId))) {
          return err({ code: 'account.unknown' });
        }
        const subject: GrantSubject = {
          accountId: input.accountId,
          population: 'admin',
        };
        // C1: the actor is still an active admin holding the rule's key, read in this unit.
        const reading = await readActingGrants(this.deps, market, self, [subject], RULE_KEYS);
        if (reading === null) return err({ code: 'access.denied' });
        const account = await this.deps.accounts.findById(market, input.accountId);
        if (account === null || account.state.population !== 'admin') {
          return err({ code: 'account.unknown' });
        }
        const accountId = account.state.id;
        const system = await this.deps.roles.findSystemRole(market, 'platform');
        const assignment = await this.deps.assignments.findByAccount(market, accountId);
        const loaded: { factor: SecondFactor | null } = { factor: null };
        // The one verdict of the command and of the admin team list's hint (slice 8c).
        const verdict = await secondFactorResetVerdict({
          actor: reading.actor,
          target: reading.targets.get(accountId)!,
          targetRoleId: assignment?.state.roleId ?? null,
          systemRoleId: system?.state.id ?? null,
          factorExists: async () => {
            loaded.factor = await this.deps.factors.findByAccount(market, accountId);
            return loaded.factor !== null;
          },
        });
        if (!verdict.ok) return err(verdict.error);
        const factor = loaded.factor!;
        const before = factor.state.state;
        factor.recordReset(now);
        await this.deps.factors.removeOf(market, accountId);
        const revokedSessions = await this.deps.sessions.revokeAllOf(
          market,
          accountId,
          'second-factor-reset',
          now,
          null,
        );
        await this.deps.challenges.voidAllOf(market, accountId);
        await this.deps.outbox.append(context, factor.pendingEvents);
        await this.deps.audit.record(
          context,
          SecondFactorResetAudit.entry(factor.state.id, {
            before: { state: before },
            after: { accountId },
          }),
        );
        return ok({ code: 'second-factor.reset', accountId, revokedSessions });
      },
      { isolation: 'serializable' },
    );
    this.#logger.log({
      msg: 'identity.reset-other-admin-second-factor',
      outcome: result.ok ? result.value.code : result.error.code,
      accountId: input.accountId,
      ...(result.ok ? { revokedSessions: result.value.revokedSessions } : {}),
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }
}
