import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac-drive/shared-kernel';
import type { CallContext, Result } from '@mondapac-drive/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { AdminSessionOpenedAudit } from '../../domain/audit';
import { openSession } from '../../domain/session';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { SessionRepository } from '../ports/session.repository';
import type { SessionTokens } from '../ports/session-secrets';
import { secondFactorStepPolicy } from '../second-factor/admin-policy';
import {
  ChallengeCodeStep,
  type ChallengeStepDependencies,
  type ChallengeStepRefusal,
} from '../second-factor/challenge-code-step';
import { parsePresentedCode, spendCode } from '../second-factor/code-check';
import type { SignInClient } from '../sign-in/sign-in-flow';
import type { FieldProblem } from '../field-problem';

export interface CompleteAdminSignInInput {
  /** The challenge's token from the answer of the password step. */
  readonly challengeToken: string;
  /** Six digits from the app, or a recovery code. */
  readonly code: string;
  readonly client: SignInClient;
}

/** A new admin session. The token goes into the cookie only, never a body or a log. */
export interface CompleteAdminSignInOutput {
  readonly code: 'signed-in';
  readonly token: string;
  readonly absoluteLifetimeSeconds: number;
}

export type CompleteAdminSignInFailure =
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] }
  | ChallengeStepRefusal
  | { readonly code: 'account.disabled' };

export interface CompleteAdminSignInDependencies extends ChallengeStepDependencies {
  readonly sessions: SessionRepository;
  readonly tokens: SessionTokens;
  readonly audit: AuditWriter;
  readonly policy: IdentityMarketPolicy;
}

/**
 * The admin's code step (identity design 3.5, 6.3 steps 5 to 7, 7.1, 7.2; AC 10; slice 7b).
 * Rule `anonymous`: the challenge's token is not a credential and the request holds no actor
 * (I1). {@link ChallengeCodeStep} with purpose `second-factor` on the active factor: the
 * challenge and the `second-factor.account` counter are reserved before the code is checked,
 * the code is checked outside any unit, and the closing unit takes the credential lock and
 * compares the challenge's credential time (Hassan I-1) before it spends the code (a time step
 * accepted once, `acceptStep`, or one recovery code spent once) and consumes the challenge.
 *
 * After the factor (6.3 step 6) a disabled account is `account.disabled`. Otherwise an admin
 * session opens with the Market's admin lifetimes (never persistent, never extended),
 * `identity.admin-session.opened` is written in the same unit (`ANONYMOUS`, the account bound
 * by the password and the factor) and the sign-in record names the session.
 */
export class CompleteAdminSignIn extends UseCase<
  CompleteAdminSignInInput,
  CompleteAdminSignInOutput,
  CompleteAdminSignInFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.complete-admin-sign-in',
    rule: { kind: 'anonymous' },
  };

  readonly #logger = new Logger('CompleteAdminSignIn');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CompleteAdminSignInDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CompleteAdminSignInInput,
  ): Promise<Result<CompleteAdminSignInOutput, CompleteAdminSignInFailure>> {
    const { market } = context;
    const presented = parsePresentedCode(input.code);
    if (presented === null) {
      return err({ code: 'validation.failed', fields: [{ path: 'code', code: 'format' }] });
    }
    const policy = secondFactorStepPolicy(this.deps.policy, market);
    const lifetime = this.deps.policy.sessionLifetime(market, 'admin');
    if (policy === null || lifetime === null) return err({ code: 'access.unavailable' });
    const issued = this.deps.tokens.issue();

    const step: ChallengeCodeStep<{ sessionId: string }> = new ChallengeCodeStep(
      this.deps,
      {
        purpose: 'second-factor',
        population: 'admin',
        factorState: 'active',
        secretOf: (factor) => factor.state.secretCiphertext,
        spend: (factor, check, now) =>
          spendCode(this.deps.factors, market, factor.state.id, check, now),
        succeed: async ({ account, now }) => {
          // 6.3 step 6: told only after the factor.
          if (account.state.status !== 'active')
            return { kind: 'refused', code: 'account.disabled' };
          const accountId = account.state.id;
          const session = openSession({
            id: this.deps.ids.next<'Session'>(),
            marketId: market.marketId,
            accountId,
            population: 'admin',
            transport: 'cookie',
            device: input.client.device ?? null,
            lifetime,
            now,
          });
          await this.deps.sessions.add(market, session, issued.tokenHash);
          await this.deps.audit.record(
            context,
            AdminSessionOpenedAudit.entry(accountId, {
              after: { sessionId: session.id, boundSubjectId: accountId },
            }),
          );
          await step.record(context, input.client, accountId, 'signed-in', now, session.id);
          return { kind: 'done', value: { sessionId: session.id } };
        },
      },
      this.#logger,
    );
    const outcome = await step.run(context, input.challengeToken, presented, input.client, policy);
    if (!outcome.ok) {
      this.log('identity.admin-sign-in.refused', context, outcome.error.code);
      return err(outcome.error as CompleteAdminSignInFailure);
    }
    this.log('identity.admin-sign-in.signed-in', context, 'signed-in');
    return ok({
      code: 'signed-in',
      token: issued.token,
      absoluteLifetimeSeconds: lifetime.absoluteLifetimeSeconds,
    });
  }

  /** Codes only: never the token, the code or the address (P 12.3). */
  private log(msg: string, context: CallContext, outcome: string): void {
    this.#logger.log({
      msg,
      outcome,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}
