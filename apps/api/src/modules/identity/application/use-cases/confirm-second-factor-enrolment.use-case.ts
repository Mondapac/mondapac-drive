import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac-drive/shared-kernel';
import type { CallContext, Population, Result } from '@mondapac-drive/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SecondFactorActivatedAudit } from '../../domain/audit';
import { displayRecoveryCode, type RecoveryCode } from '../../domain/recovery-code';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { SessionRepository } from '../ports/session.repository';
import { secondFactorStepPolicy } from '../second-factor/admin-policy';
import {
  ChallengeCodeStep,
  type ChallengeStepDependencies,
  type ChallengeStepRefusal,
} from '../second-factor/challenge-code-step';
import { newRecoveryCodes, parsePresentedCode } from '../second-factor/code-check';
import type { SignInClient } from '../sign-in/sign-in-flow';
import type { FieldProblem } from '../field-problem';

export interface ConfirmSecondFactorEnrolmentInput {
  /** The enrolment challenge's token from the answer that started the enrolment. */
  readonly challengeToken: string;
  /** Six digits from the app (a recovery code proves no new device). */
  readonly code: string;
  readonly client: SignInClient;
}

/** The factor is active. The recovery codes are shown once, here, and stored only as hashes. */
export interface ConfirmSecondFactorEnrolmentOutput {
  readonly code: 'second-factor-activated';
  readonly recoveryCodes: readonly string[];
}

export type ConfirmSecondFactorEnrolmentFailure =
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] }
  | ChallengeStepRefusal;

export interface ConfirmSecondFactorEnrolmentDependencies extends ChallengeStepDependencies {
  readonly sessions: SessionRepository;
  readonly audit: AuditWriter;
  readonly policy: IdentityMarketPolicy;
}

/**
 * Confirms an enrolment started from a mailed link (identity design 3.6 `pending` → `active`,
 * HF6, 7.1, 7.3; AC 11, AC 22; slice 7b items D and I). Rule `anonymous`: the enrolment
 * challenge, issued after the link and the password, binds the account (I1). The code step of
 * {@link ChallengeCodeStep} with purpose `second-factor-enrolment` on the pending factor; an app
 * code only. Ten recovery codes are made and hashed outside any unit once the code matched.
 *
 * The closing unit, after the credential lock and the challenge's credential time (I-1),
 * activates the factor at the version read with the code's step spent and the ten hashes,
 * consumes the challenge, and then (item D): **every session of the account is revoked**
 * (`second-factor-activated`; the request has no session of its own, so none is rotated), **every
 * open challenge is void**, `identity.second-factor.activated` is written (`ANONYMOUS`, the
 * account bound by the link, the password and the code) and `identity.second-factor-changed.v1`
 * (`activated`) recorded. No session opens: the admin then signs in with the new factor.
 */
export class ConfirmSecondFactorEnrolment extends UseCase<
  ConfirmSecondFactorEnrolmentInput,
  ConfirmSecondFactorEnrolmentOutput,
  ConfirmSecondFactorEnrolmentFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.confirm-second-factor-enrolment',
    rule: { kind: 'anonymous' },
  };

  readonly #logger = new Logger('ConfirmSecondFactorEnrolment');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ConfirmSecondFactorEnrolmentDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: ConfirmSecondFactorEnrolmentInput,
  ): Promise<Result<ConfirmSecondFactorEnrolmentOutput, ConfirmSecondFactorEnrolmentFailure>> {
    return confirmSecondFactorEnrolment(this.deps, this.#logger, 'admin', context, input);
  }
}

export async function confirmSecondFactorEnrolment(
  deps: ConfirmSecondFactorEnrolmentDependencies,
  logger: Logger,
  population: Population,
  context: CallContext,
  input: ConfirmSecondFactorEnrolmentInput,
): Promise<Result<ConfirmSecondFactorEnrolmentOutput, ConfirmSecondFactorEnrolmentFailure>> {
  const { market } = context;
  const presented = parsePresentedCode(input.code, false);
  if (presented === null) {
    return err({ code: 'validation.failed', fields: [{ path: 'code', code: 'format' }] });
  }
  const policy = secondFactorStepPolicy(deps.policy, market);
  if (policy === null) return err({ code: 'access.unavailable' });
  let fresh: { codes: readonly RecoveryCode[]; hashes: readonly Uint8Array[] } | null = null;

  const step: ChallengeCodeStep<null> = new ChallengeCodeStep(
    deps,
    {
      purpose: 'second-factor-enrolment',
      population: population,
      factorState: 'pending',
      secretOf: (factor) => factor.state.secretCiphertext,
      prepare: async (account) => {
        fresh = await newRecoveryCodes(deps.secrets, market, account.state.id);
      },
      spend: async (factor, check, now) => {
        if (check.kind !== 'totp' || fresh === null) return false;
        const activated = factor.activate({
          acceptedStep: check.step,
          recoveryCodeHashes: fresh.hashes,
          now,
        });
        if (!activated.ok) return false;
        await deps.factors.save(market, factor);
        await deps.outbox.append(context, factor.pendingEvents);
        return true;
      },
      succeed: async ({ account, factor, now }) => {
        const accountId = account.state.id;
        await deps.sessions.revokeAllOf(market, accountId, 'second-factor-activated', now, null);
        await deps.challenges.voidAllOf(market, accountId);
        await deps.audit.record(
          context,
          SecondFactorActivatedAudit.entry(factor.state.id, {
            after: { accountId, boundSubjectId: accountId },
          }),
        );
        await step.record(context, input.client, accountId, 'second-factor-activated', now);
        return { kind: 'done', value: null };
      },
    },
    logger,
  );
  const outcome = await step.run(context, input.challengeToken, presented, input.client, policy);
  const codes = fresh as { codes: readonly RecoveryCode[] } | null;
  if (!outcome.ok || codes === null) {
    const code = outcome.ok ? 'access.unavailable' : outcome.error.code;
    logOutcome(logger, 'identity.second-factor-enrolment.refused', context, code);
    return err((outcome.ok ? { code } : outcome.error) as ConfirmSecondFactorEnrolmentFailure);
  }
  logOutcome(
    logger,
    'identity.second-factor-enrolment.activated',
    context,
    'second-factor-activated',
  );
  return ok({
    code: 'second-factor-activated',
    recoveryCodes: codes.codes.map(displayRecoveryCode),
  });
}

/** Codes only: never the token, the code or a recovery code (P 12.3). */
function logOutcome(logger: Logger, msg: string, context: CallContext, outcome: string): void {
  logger.log({
    msg,
    outcome,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
}
