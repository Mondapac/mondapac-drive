import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac-drive/shared-kernel';
import type { CallContext, Result } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SecondFactorReplacedAudit } from '../../domain/audit';
import type { SessionRepository } from '../ports/session.repository';
import type { SessionTokens } from '../ports/session-secrets';
import type { SignInChallengeRepository } from '../ports/sign-in-challenge.repository';
import { SignedInFactorStep } from '../second-factor/signed-in-factor-step';
import {
  type FactorCodeInput,
  type FactorStepFailure,
  type FactorDeviceDependencies,
  codeField,
  logOutcome,
} from '../second-factor/factor-device';

/** The new device is the factor; the current session continues with a new token (cookie only). */
export interface CompleteSecondFactorReplacementOutput {
  readonly code: 'second-factor-replaced';
  readonly token: string;
  /** What is left of the session's absolute lifetime: an admin cookie is never persistent. */
  readonly sessionAbsoluteExpiresAt: string;
}

export interface CompleteSecondFactorReplacementDependencies extends FactorDeviceDependencies {
  readonly sessions: SessionRepository;
  readonly challenges: SignInChallengeRepository;
  readonly tokens: SessionTokens;
}

/**
 * Completes a device replacement (identity design 3.6 swap, M13; slice 7b items D and E). Rule
 * `own-resources`. The first valid code of the new device (an app code; a recovery code proves
 * no new device) swaps the secrets in one guarded update at the version read; the old secret is
 * void. Then, in the same unit: **the current session continues with a new token** (rotated; one
 * ended meanwhile is `session.invalid` and nothing changes), **every other session is revoked**
 * (`second-factor-replaced`), **every open challenge is void**, `identity.second-factor.replaced`
 * is written and `identity.second-factor-changed.v1` (`replaced`) sends the alert mail.
 */
export class CompleteSecondFactorReplacement extends UseCase<
  FactorCodeInput,
  CompleteSecondFactorReplacementOutput,
  FactorStepFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.complete-second-factor-replacement',
    rule: { kind: 'own-resources' },
    // Admin accounts only: the step refuses any other population before a seller check matters.
  };

  readonly #logger = new Logger('CompleteSecondFactorReplacement');
  readonly #step: SignedInFactorStep;

  constructor(
    gate: UseCaseGate,
    private readonly deps: CompleteSecondFactorReplacementDependencies,
  ) {
    super(gate);
    this.#step = new SignedInFactorStep(deps, this.#logger, 'admin');
  }

  protected async handle(
    context: CallContext,
    input: FactorCodeInput,
  ): Promise<Result<CompleteSecondFactorReplacementOutput, FactorStepFailure>> {
    const { market, actor } = context;
    const presented = codeField(input.code, false);
    if (!presented.ok) return presented;
    if (actor.kind !== 'authenticated') return err({ code: 'access.denied' });
    const throttle = this.deps.policy.secondFactorThrottle(market);
    if (throttle === null) return err({ code: 'access.unavailable' });
    const issued = this.deps.tokens.issue();
    const result = await this.#step.run(context, presented.value, throttle, {
      secretOf: (factor) => factor.state.pendingSecretCiphertext,
      spend: async (factor, check, now) => {
        if (check.kind !== 'totp' || !factor.completeReplacement(check.step, now).ok) return false;
        await this.deps.factors.save(market, factor);
        await this.deps.outbox.append(context, factor.pendingEvents);
        return true;
      },
      succeed: async ({ account, factor, now }) => {
        const accountId = account.state.id;
        const { sessions } = this.deps;
        if (!(await sessions.rotate(market, actor.sessionId, accountId, issued.tokenHash))) {
          return err({ code: 'session.invalid' });
        }
        const session = await sessions.findById(market, actor.sessionId);
        if (session === null) return err({ code: 'session.invalid' });
        await sessions.revokeAllOf(
          market,
          accountId,
          'second-factor-replaced',
          now,
          actor.sessionId,
        );
        await this.deps.challenges.voidAllOf(market, accountId);
        await this.deps.audit.record(
          context,
          SecondFactorReplacedAudit.entry(factor.state.id, { after: { accountId } }),
        );
        return ok({
          code: 'second-factor-replaced' as const,
          token: issued.token,
          sessionAbsoluteExpiresAt: session.absoluteExpiresAt.toString(),
        });
      },
    });
    logOutcome(
      this.#logger,
      'identity.second-factor-replacement.complete',
      context,
      result.ok ? result.value.code : result.error.code,
    );
    return result;
  }
}
