import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac-drive/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac-drive/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SecondFactorResetAudit } from '../../domain/audit';
import { parseEmailAddress } from '../../domain/email-address';
import type { AccountRepository } from '../ports/account.repository';
import type { SecondFactorRepository } from '../ports/second-factor.repository';
import type { SessionRepository } from '../ports/session.repository';
import type { SignInChallengeRepository } from '../ports/sign-in-challenge.repository';

export interface ResetAdminSecondFactorInput {
  /** The admin's sign-in address, typed by the operator. Personal data: never logged. */
  readonly email: string;
}

export interface ResetAdminSecondFactorOutput {
  readonly code: 'second-factor.reset';
  readonly accountId: Id<'Account'>;
  readonly revokedSessions: number;
}

export type ResetAdminSecondFactorFailure =
  | { readonly code: 'validation.failed' }
  /** No admin account with this address in the Market. */
  | { readonly code: 'account.unknown' }
  /** The account has no factor: nothing to reset (its next sign-in mails an enrolment link). */
  | { readonly code: 'second-factor.none' }
  | { readonly code: 'access.denied' };

export interface ResetAdminSecondFactorDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly factors: SecondFactorRepository;
  readonly sessions: SessionRepository;
  readonly challenges: SignInChallengeRepository;
  readonly outbox: OutboxWriter;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

/**
 * The operator's `reset-admin-second-factor` break-glass (identity design 3.6 `active` → `none`,
 * 7.3, 7.4; AC 33; slice 7b). Rule `system`: the command runs it as the Market's `SYSTEM` actor
 * after it has written the operator's line to the external log (`platform-audit.md` 9.2, Hassan
 * L6); the audit row's correlation id links the two.
 *
 * In one unit: the factor's last version step (`SecondFactor.recordReset`), its removal with its
 * recovery codes, **every session of the account revoked** (`second-factor-reset`), **every open
 * challenge void**, `identity.second-factor-changed.v1` (`reset`: the alert mail) and
 * `identity.second-factor.reset` as `SYSTEM`. The `second-factor.account` counter is never
 * touched (6.8, Hassan I-4): a block runs to its end. The admin's next sign-in finds no factor
 * and is mailed an enrolment link (HF6). The address is never logged or audited.
 */
export class ResetAdminSecondFactor extends UseCase<
  ResetAdminSecondFactorInput,
  ResetAdminSecondFactorOutput,
  ResetAdminSecondFactorFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.reset-admin-second-factor',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('ResetAdminSecondFactor');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ResetAdminSecondFactorDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ResetAdminSecondFactorInput,
  ): Promise<Result<ResetAdminSecondFactorOutput, ResetAdminSecondFactorFailure>> {
    const { market } = context;
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const email = parseEmailAddress(input.email);
    if (!email.ok) return err({ code: 'validation.failed' });

    const result = await this.deps.unitOfWork.run(
      market,
      async (): Promise<Result<ResetAdminSecondFactorOutput, ResetAdminSecondFactorFailure>> => {
        const now = this.deps.clock.now();
        const account = await this.deps.accounts.findByEmail(
          market,
          'admin',
          email.value.normalized,
        );
        if (account === null) return err({ code: 'account.unknown' });
        const accountId = account.state.id;
        const factor = await this.deps.factors.findByAccount(market, accountId);
        if (factor === null) return err({ code: 'second-factor.none' });
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
    );
    this.#logger.log({
      msg: 'identity.admin-second-factor.reset',
      outcome: result.ok ? result.value.code : result.error.code,
      ...(result.ok
        ? { accountId: result.value.accountId, revokedSessions: result.value.revokedSessions }
        : {}),
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }
}
