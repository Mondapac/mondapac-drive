import { err } from '@mondapac-drive/shared-kernel';
import type { CallContext, Result } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { parseEmailAddress } from '../../domain/email-address';
import { MAX_PASSWORD_BYTES } from '../../domain/password-policy';
import type { OneTimeLinkRepository } from '../ports/one-time-link.repository';
import type { OpaqueTokens } from '../ports/second-factor-tokens';
import type { SecondFactorRepository } from '../ports/second-factor.repository';
import type { SignInChallengeRepository } from '../ports/sign-in-challenge.repository';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { secondFactorStepPolicy } from '../second-factor/admin-policy';
import { AdminSecondStep, type AdminSecondStepOutcome } from '../sign-in/admin-second-step';
import {
  SignInFlow,
  type SignInClient,
  type SignInDependencies,
  type SignInRefusal,
} from '../sign-in/sign-in-flow';
import type { FieldProblem } from '../field-problem';

export interface SignInAdminInput {
  readonly email: string;
  readonly password: string;
  readonly client: SignInClient;
}

export type SignInAdminOutput = AdminSecondStepOutcome;

export type SignInAdminFailure =
  { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] } | SignInRefusal;

export interface SignInAdminDependencies extends SignInDependencies {
  readonly factors: SecondFactorRepository;
  readonly challenges: SignInChallengeRepository;
  readonly links: OneTimeLinkRepository;
  readonly outbox: OutboxWriter;
  readonly challengeTokens: OpaqueTokens;
}

/**
 * The admin's password step (identity design 3.6, 6.3 steps 1 to 5, 7.2; AC 10, AC 22; slice
 * 7b). Rule `anonymous`. The sequence of 6.3 in {@link SignInFlow} for the admin population,
 * the same reservation, hash and closing units as the other populations; after a correct
 * password, {@link AdminSecondStep} decides, before the account's state is told: a challenge
 * (`second-factor-required`, with its token for the code step), the HF2 lock
 * (`second-factor.locked`), or, with no active factor, an enrolment link mailed to the account
 * (`second-factor-enrolment-required`). A password alone never opens an admin session (AC 10).
 *
 * The challenge policy and the `second-factor.account` counter are read before any unit: a
 * Market without them answers `access.unavailable` and nothing is counted or hashed.
 */
export class SignInAdmin extends UseCase<SignInAdminInput, SignInAdminOutput, SignInAdminFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.sign-in-admin',
    rule: { kind: 'anonymous' },
  };

  readonly #flow: SignInFlow;

  constructor(
    gate: UseCaseGate,
    private readonly deps: SignInAdminDependencies,
  ) {
    super(gate);
    const step = new AdminSecondStep({
      factors: deps.factors,
      challenges: deps.challenges,
      links: deps.links,
      throttles: deps.throttles,
      keys: deps.keys,
      outbox: deps.outbox,
      policy: deps.policy,
      ids: deps.ids,
      challengeTokens: deps.challengeTokens,
    });
    this.#flow = new SignInFlow('admin', deps, step);
  }

  protected async handle(
    context: CallContext,
    input: SignInAdminInput,
  ): Promise<Result<SignInAdminOutput, SignInAdminFailure>> {
    const email = parseEmailAddress(input.email);
    if (!email.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'email', code: 'format' }] });
    }
    if (Buffer.byteLength(input.password, 'utf8') > MAX_PASSWORD_BYTES) {
      return err({ code: 'validation.failed', fields: [{ path: 'password', code: 'length' }] });
    }
    const policy = secondFactorStepPolicy(this.deps.policy, context.market);
    if (policy === null) return err({ code: 'access.unavailable' });
    return this.#flow.runAdmin(context, email.value, input.password, input.client, {
      challenge: policy.challenge,
      secondFactorThrottle: policy.secondFactorThrottle,
    });
  }
}
