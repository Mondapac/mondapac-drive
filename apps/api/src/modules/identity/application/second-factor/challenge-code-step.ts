import type { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac-drive/shared-kernel';
import type {
  CallContext,
  Clock,
  Id,
  IdGenerator,
  Population,
  Result,
  Temporal,
} from '@mondapac-drive/shared-kernel';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { Account } from '../../domain/account';
import type { SecondFactor, SecondFactorStateCode } from '../../domain/second-factor';
import {
  challengeIsOpen,
  challengeMatchesCredential,
  type ChallengePolicy,
  type ChallengePurpose,
  type SignInChallenge,
} from '../../domain/sign-in-challenge';
import { reservationVerdict, type ThrottleRule } from '../../domain/throttle';
import type { AccountRepository } from '../ports/account.repository';
import type { OpaqueTokens } from '../ports/second-factor-tokens';
import type { SecondFactorSecrets } from '../ports/second-factor-secrets';
import type { SecondFactorRepository } from '../ports/second-factor.repository';
import type { ThrottleKeys } from '../ports/session-secrets';
import type { SignInChallengeRepository } from '../ports/sign-in-challenge.repository';
import type { SignInRecordRepository } from '../ports/sign-in-record.repository';
import type { ThrottleCounter, ThrottleRepository } from '../ports/throttle.repository';
import type { SignInClient } from '../sign-in/sign-in-flow';
import {
  checkPresentedCode,
  codeProven,
  recordCodeFailure,
  reserveSecondFactor,
  secondFactorCounter,
  type CodeCheck,
  type PresentedCode,
  type ReservedAttempt,
} from './code-check';

/** What a challenge's code step needs (identity design 6.3 step 5, 3.6, 6.8). */
export interface ChallengeStepDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly challenges: SignInChallengeRepository;
  readonly factors: SecondFactorRepository;
  readonly throttles: ThrottleRepository;
  readonly records: SignInRecordRepository;
  readonly keys: ThrottleKeys;
  readonly secrets: SecondFactorSecrets;
  readonly challengeTokens: OpaqueTokens;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** The Market's policy values a code step reads before any unit (null: fail closed). */
export interface ChallengeStepPolicy {
  readonly challenge: ChallengePolicy;
  readonly secondFactorThrottle: ThrottleRule;
  readonly signInOrigin: ThrottleRule;
}

/** Why a code step stopped, as the caller answers it. */
export type ChallengeStepRefusal =
  /** The token is unknown, of another purpose or Market, used, expired or out of attempts. */
  | { readonly code: 'challenge.rejected' }
  /** A wrong, replayed or spent code; the attempt stays counted (HF2). */
  | { readonly code: 'second-factor.invalid' }
  /** HF2: the factor step is refused until the block ends. */
  | { readonly code: 'second-factor.locked'; readonly retryAfterSeconds: number }
  /** `sign-in.origin` refused an unknown token (HF3). */
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | { readonly code: 'access.unavailable' };

/** What the closing unit hands to the step's success: everything re-read after the lock. */
export interface ChallengeStepSuccess {
  readonly account: Account;
  readonly factor: SecondFactor;
  readonly challenge: SignInChallenge;
  readonly now: Temporal.Instant;
}

/** One code step's specifics. */
export interface ChallengeStepSpec<T> {
  readonly purpose: ChallengePurpose;
  /** The population whose accounts may use the step (7b: `admin`). */
  readonly population: Population;
  /** The factor state the step works on: `active` to sign in, `pending` to enrol. */
  readonly factorState: SecondFactorStateCode;
  /** The ciphertext the code is checked against. */
  readonly secretOf: (factor: SecondFactor) => string;
  /**
   * Slow work for the account found, outside any unit, after the code was checked (for example
   * the keyed hashes of new recovery codes). Optional.
   */
  readonly prepare?: (account: Account) => Promise<void>;
  /**
   * Spends the code in the closing unit: true when it took effect (a step accepted once, a
   * recovery code spent once, an activation saved at the version read).
   */
  readonly spend: (
    factor: SecondFactor,
    check: CodeCheck,
    now: Temporal.Instant,
  ) => Promise<boolean>;
  /**
   * The rest of the closing unit after the code was spent and the challenge consumed. It does
   * nothing external (the unit may run again, P 3.1 row 7).
   */
  readonly succeed: (success: ChallengeStepSuccess) => Promise<
    | { readonly kind: 'done'; readonly value: T }
    /** A refusal of the step's own (for example `account.disabled`); the unit still commits. */
    | { readonly kind: 'refused'; readonly code: string }
  >;
}

type Reserved =
  | { readonly kind: 'refused'; readonly refusal: ChallengeStepRefusal }
  | {
      readonly kind: 'reserved';
      readonly challenge: SignInChallenge;
      readonly account: Account;
      readonly factor: SecondFactor;
      readonly attempt: ReservedAttempt;
    };

const REJECTED = Object.freeze({ code: 'challenge.rejected' as const });
const INVALID = Object.freeze({ code: 'second-factor.invalid' as const });
const UNAVAILABLE = Object.freeze({ code: 'access.unavailable' as const });

/**
 * The code step of a sign-in challenge (identity design 6.3 step 5, 3.6, 6.8; Hassan's 7b
 * bindings I-1 to I-3). Shared by the admin's sign-in completion and the confirmation of an
 * enrolment; each passes its purpose, its factor state and what success does.
 *
 * 1. **Reservation unit** (HF1, HF2): the challenge by the hash of its token, its account (of
 *    the step's population) and the factor (in the step's state). Anything missing is one
 *    answer, `challenge.rejected`, counted on `sign-in.origin` (HF3), so token guessing is
 *    bounded per origin. Otherwise the `second-factor.account` counter is reserved (at its
 *    limit: `second-factor.locked`, HF2) and then one challenge attempt (`reserveAttempt`, a
 *    guarded statement: out of attempts, `challenge.rejected`).
 * 2. **The code is checked outside any unit**, with the steps of `candidateSteps(clock.now())`
 *    (I-2). A secret that cannot be used answers as a wrong code and alarms (I-3).
 * 3. **Closing unit** (I-1): the account's credential lock first, the account read again, and
 *    the challenge's `credentialChangedAt` compared with the credential's: a password changed
 *    since the challenge refuses it (HF11). The factor is read again (the same id and state).
 *    The code is spent (`spend`) in this unit; a code that does not take effect stays counted,
 *    and the attempt that reaches the limit blocks the counter and locks the factor (HF2, item
 *    C). Then the challenge is consumed in the same unit; a concurrent completion that consumed
 *    it first makes this unit commit nothing (`err`), so the spent code is not kept either.
 *    The counter's reservation is given back and `succeed` runs.
 *
 * Every attempt that reaches a decision leaves a sign-in record (10.2), with the account when
 * known, the client's address and the correlation id; never the code or the token.
 */
export class ChallengeCodeStep<T> {
  constructor(
    private readonly deps: ChallengeStepDependencies,
    private readonly spec: ChallengeStepSpec<T>,
    private readonly logger: Logger,
  ) {}

  async run(
    context: CallContext,
    token: string,
    presented: PresentedCode,
    client: SignInClient,
    policy: ChallengeStepPolicy,
  ): Promise<Result<T, ChallengeStepRefusal | { readonly code: string }>> {
    const { market } = context;
    const { unitOfWork, throttles, keys } = this.deps;
    const tokenHash = this.deps.challengeTokens.hashOf(token);

    // 1. The reservation unit.
    let reserved: Reserved;
    try {
      const run = await unitOfWork.run(market, async (): Promise<Result<Reserved, never>> => {
        const now = this.deps.clock.now();
        const found = await this.find(context, tokenHash, policy, now);
        if (found === null) {
          const origin: ThrottleCounter = {
            kind: 'sign-in.origin',
            keyHash: keys.origin(market, client.origin),
            accountKey: null,
            rule: policy.signInOrigin,
          };
          const [reservation] = await throttles.reserve(market, [origin], now);
          const verdict = reservationVerdict(
            [{ reservation: reservation!, rule: policy.signInOrigin }],
            now,
          );
          const refusal: ChallengeStepRefusal = verdict.allowed
            ? REJECTED
            : { code: 'request.throttled', retryAfterSeconds: verdict.retryAfterSeconds };
          await this.record(context, client, null, refusal.code, now);
          return ok({ kind: 'refused', refusal });
        }
        const { challenge, account, factor } = found;
        const counter = secondFactorCounter(
          keys,
          market,
          account.state.population,
          account.state.email.normalized,
          policy.secondFactorThrottle,
        );
        const attempt = await reserveSecondFactor(throttles, market, counter, now);
        if (attempt.kind === 'locked') {
          await this.record(context, client, account.state.id, 'second-factor.locked', now);
          return ok({
            kind: 'refused',
            refusal: { code: 'second-factor.locked', retryAfterSeconds: attempt.retryAfterSeconds },
          });
        }
        const taken = await this.deps.challenges.reserveAttempt(
          market,
          challenge.id,
          policy.challenge.maxAttempts,
          now,
        );
        if (!taken) {
          await throttles.release(market, [attempt.reserved.reservation]);
          await this.record(context, client, account.state.id, REJECTED.code, now);
          return ok({ kind: 'refused', refusal: REJECTED });
        }
        return ok({ kind: 'reserved', challenge, account, factor, attempt: attempt.reserved });
      });
      if (!run.ok) return err(UNAVAILABLE);
      reserved = run.value;
    } catch {
      this.warn('identity.second-factor-step.reservation-unavailable', context);
      return err(UNAVAILABLE);
    }
    if (reserved.kind === 'refused') return err(reserved.refusal);
    const { challenge, account, factor, attempt } = reserved;
    const accountId = account.state.id;

    // 2. The code, outside any unit (I-2, I-3).
    const check = await checkPresentedCode(
      { secrets: this.deps.secrets, clock: this.deps.clock },
      this.logger,
      context,
      accountId,
      this.spec.secretOf(factor),
      presented,
    );
    if (check.kind !== 'no-match' && this.spec.prepare !== undefined) {
      try {
        await this.spec.prepare(account);
      } catch (error) {
        if (codeProven(check, false)) await this.releaseQuietly(context, attempt);
        throw error;
      }
    }

    // 3. The closing unit (I-1).
    type Closed =
      | { readonly kind: 'done'; readonly value: T }
      | { readonly kind: 'refused'; readonly refusal: ChallengeStepRefusal | { code: string } };
    let closed: Result<Closed, 'lost'>;
    // Whether the last run of the closing unit spent the code (a retried unit starts again).
    let spentInUnit = false;
    try {
      closed = await unitOfWork.run(market, async (): Promise<Result<Closed, 'lost'>> => {
        spentInUnit = false;
        const now = this.deps.clock.now();
        const locked = await this.deps.accounts.lockCredential(market, accountId);
        const current = locked ? await this.deps.accounts.findById(market, accountId) : null;
        const currentFactor =
          current === null ? null : await this.deps.factors.findByAccount(market, accountId);
        if (
          current === null ||
          !challengeMatchesCredential(challenge, current.state.credential.changedAt) ||
          currentFactor === null ||
          currentFactor.state.id !== factor.state.id ||
          currentFactor.state.state !== this.spec.factorState
        ) {
          // Not a wrong code: the attempt is given back; the challenge cannot complete.
          await this.deps.throttles.release(market, [attempt.reservation]);
          await this.record(context, client, accountId, REJECTED.code, now);
          return ok({ kind: 'refused', refusal: REJECTED });
        }
        const spent =
          check.kind !== 'no-match' && (await this.spec.spend(currentFactor, check, now));
        spentInUnit = spent;
        if (!spent) {
          const lockedNow = await recordCodeFailure(
            {
              throttles: this.deps.throttles,
              factors: this.deps.factors,
              outbox: this.deps.outbox,
            },
            context,
            attempt,
            accountId,
            now,
          );
          const refusal: ChallengeStepRefusal = lockedNow
            ? {
                code: 'second-factor.locked',
                retryAfterSeconds: attempt.rule.blockMinutes * 60,
              }
            : INVALID;
          await this.record(context, client, accountId, refusal.code, now);
          return ok({ kind: 'refused', refusal });
        }
        // The attempt is given back before the challenge row is touched: the reservation unit
        // takes the throttle, then the challenge, so this unit keeps the same order (Mojtaba,
        // PR #162; data design 3.3). A lost consume rolls the release back with the unit.
        await this.deps.throttles.release(market, [attempt.reservation]);
        // The single use, in the unit that spent the code (I-1); lost to a concurrent use:
        // nothing of this unit is kept.
        if (!(await this.deps.challenges.consume(market, challenge.id, now))) return err('lost');
        const outcome = await this.spec.succeed({
          account: current,
          factor: currentFactor,
          challenge,
          now,
        });
        if (outcome.kind === 'refused') {
          await this.record(context, client, accountId, outcome.code, now);
          return ok({ kind: 'refused', refusal: { code: outcome.code } });
        }
        return ok(outcome);
      });
    } catch (error) {
      this.warn('identity.second-factor-step.closing-failed', context);
      // Nothing of the unit was kept. A code proven correct (an app code that matched, or a
      // recovery code the unit spent) gets its attempt back, best effort; any other keeps it
      // counted, so a failing unit never refunds a guess (HF2; Mojtaba and Hassan, PR #162).
      if (codeProven(check, spentInUnit)) await this.releaseQuietly(context, attempt);
      throw error;
    }
    if (!closed.ok) {
      await this.releaseQuietly(context, attempt);
      return err(REJECTED);
    }
    if (closed.value.kind === 'refused') return err(closed.value.refusal);
    return ok(closed.value.value);
  }

  /** One sign-in record (10.2): never the code, the token or the address's owner's email. */
  async record(
    context: CallContext,
    client: SignInClient,
    accountId: Id<'Account'> | null,
    outcome: string,
    now: Temporal.Instant,
    sessionId: Id<'Session'> | null = null,
  ): Promise<void> {
    await this.deps.records.add(context.market, {
      id: this.deps.ids.next<'SignInRecord'>(),
      population: this.spec.population,
      accountId,
      outcome,
      occurredAt: now,
      address: client.address,
      sessionId,
      correlationId: context.correlationId,
    });
  }

  private async find(
    context: CallContext,
    tokenHash: Uint8Array | null,
    policy: ChallengeStepPolicy,
    now: Temporal.Instant,
  ): Promise<{ challenge: SignInChallenge; account: Account; factor: SecondFactor } | null> {
    const { market } = context;
    if (tokenHash === null) return null;
    const challenge = await this.deps.challenges.findByTokenHash(market, tokenHash);
    if (
      challenge === null ||
      !challengeIsOpen(challenge, this.spec.purpose, policy.challenge, now)
    ) {
      return null;
    }
    const account = await this.deps.accounts.findById(market, challenge.accountId);
    if (account === null || account.state.population !== this.spec.population) return null;
    const factor = await this.deps.factors.findByAccount(market, account.state.id);
    if (factor === null || factor.state.state !== this.spec.factorState) return null;
    return { challenge, account, factor };
  }

  private async releaseQuietly(context: CallContext, attempt: ReservedAttempt): Promise<void> {
    try {
      await this.deps.unitOfWork.run(context.market, async () => {
        await this.deps.throttles.release(context.market, [attempt.reservation]);
        return ok(undefined);
      });
    } catch {
      this.warn('identity.second-factor-step.release-unavailable', context);
    }
  }

  private warn(msg: string, context: CallContext): void {
    this.logger.warn({
      msg,
      purpose: this.spec.purpose,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}
