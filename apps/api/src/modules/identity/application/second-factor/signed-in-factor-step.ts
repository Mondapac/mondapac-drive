import type { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac-drive/shared-kernel';
import type {
  CallContext,
  Clock,
  Population,
  Result,
  Temporal,
} from '@mondapac-drive/shared-kernel';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { Account } from '../../domain/account';
import type { SecondFactor } from '../../domain/second-factor';
import type { ThrottleRule } from '../../domain/throttle';
import type { AccountRepository } from '../ports/account.repository';
import type { SecondFactorSecrets } from '../ports/second-factor-secrets';
import type { SecondFactorRepository } from '../ports/second-factor.repository';
import type { ThrottleKeys } from '../ports/session-secrets';
import type { ThrottleRepository } from '../ports/throttle.repository';
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

/** What a signed-in factor step needs (identity design 3.6, 6.8). */
export interface SignedInFactorDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly factors: SecondFactorRepository;
  readonly throttles: ThrottleRepository;
  readonly keys: ThrottleKeys;
  readonly secrets: SecondFactorSecrets;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
}

export type SignedInFactorRefusal =
  | { readonly code: 'second-factor.invalid' }
  | { readonly code: 'second-factor.locked'; readonly retryAfterSeconds: number }
  /** No active factor, or (to complete a replacement) no waiting one. */
  | { readonly code: 'second-factor.unavailable' }
  | { readonly code: 'session.invalid' }
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' };

/** One signed-in step's specifics. */
export interface SignedInFactorSpec<T> {
  /** The ciphertext the code is checked against, or null when the step cannot run. */
  readonly secretOf: (factor: SecondFactor) => string | null;
  /** Slow work once the code matched, outside any unit (a new secret sealed, codes hashed). */
  readonly prepare?: (account: Account, factor: SecondFactor) => Promise<void>;
  /** Spends the code in the closing unit; true when it took effect. */
  readonly spend: (
    factor: SecondFactor,
    check: CodeCheck,
    now: Temporal.Instant,
  ) => Promise<boolean>;
  /**
   * The rest of the closing unit with the factor read again after the spend. A refusal here
   * (`session.invalid`) makes the unit commit nothing, so the spent code is kept unspent.
   */
  readonly succeed: (input: {
    readonly account: Account;
    readonly factor: SecondFactor;
    readonly now: Temporal.Instant;
  }) => Promise<Result<T, SignedInFactorRefusal>>;
}

/**
 * A code step of a signed-in holder (identity design 3.6 `active` → `active`, 6.8; slice 7b item
 * E): starting or completing a device replacement and regenerating the recovery codes. The
 * actor's own account only (`own-resources`); nothing in the input names one.
 *
 * 1. Reservation unit: the account and its active factor, then the `second-factor.account`
 *    counter reserved before the code is checked (HF1, HF2; at its limit `second-factor.locked`).
 * 2. The code checked outside any unit with `candidateSteps(clock.now())` (I-2); a secret that
 *    cannot be used answers as a wrong code and alarms (I-3); `prepare` runs.
 * 3. Closing unit: the account's credential lock first (data design 3.3), the factor read again (the same id, active, the same secret as checked), the
 *    code spent (a step accepted once or a recovery code spent once); a failure stays counted and
 *    the attempt that reaches the limit locks the factor (HF2). On success the reservation is
 *    given back and `succeed` runs with the factor read again.
 */
export class SignedInFactorStep {
  constructor(
    private readonly deps: SignedInFactorDependencies,
    private readonly logger: Logger,
    /** Whose own factor the step works on: the use case that owns the step fixes it. */
    private readonly population: Population,
  ) {}

  async run<T>(
    context: CallContext,
    presented: PresentedCode,
    throttle: ThrottleRule,
    spec: SignedInFactorSpec<T>,
  ): Promise<Result<T, SignedInFactorRefusal>> {
    const { market, actor } = context;
    if (actor.kind !== 'authenticated' || actor.population !== this.population) {
      return err({ code: 'access.denied' });
    }
    const accountId = actor.accountId;
    const { unitOfWork, throttles } = this.deps;

    type Reserved =
      | { readonly kind: 'refused'; readonly refusal: SignedInFactorRefusal }
      | {
          readonly kind: 'reserved';
          readonly account: Account;
          readonly factor: SecondFactor;
          readonly secret: string;
          readonly attempt: ReservedAttempt;
        };
    let reserved: Reserved;
    try {
      const run = await unitOfWork.run(market, async (): Promise<Result<Reserved, never>> => {
        const now = this.deps.clock.now();
        const account = await this.deps.accounts.findById(market, accountId);
        if (account === null) return ok({ kind: 'refused', refusal: { code: 'session.invalid' } });
        const factor = await this.deps.factors.findByAccount(market, accountId);
        const secret = factor !== null && factor.isActive ? spec.secretOf(factor) : null;
        if (factor === null || secret === null) {
          return ok({ kind: 'refused', refusal: { code: 'second-factor.unavailable' } });
        }
        const counter = secondFactorCounter(
          this.deps.keys,
          market,
          account.state.population,
          account.state.email.normalized,
          throttle,
        );
        const attempt = await reserveSecondFactor(throttles, market, counter, now);
        if (attempt.kind === 'locked') {
          return ok({
            kind: 'refused',
            refusal: { code: 'second-factor.locked', retryAfterSeconds: attempt.retryAfterSeconds },
          });
        }
        return ok({ kind: 'reserved', account, factor, secret, attempt: attempt.reserved });
      });
      if (!run.ok) return err({ code: 'access.unavailable' });
      reserved = run.value;
    } catch {
      this.warn('identity.signed-in-factor.reservation-unavailable', context);
      return err({ code: 'access.unavailable' });
    }
    if (reserved.kind === 'refused') return err(reserved.refusal);
    const { account, factor, secret, attempt } = reserved;

    const check = await checkPresentedCode(
      { secrets: this.deps.secrets, clock: this.deps.clock },
      this.logger,
      context,
      accountId,
      secret,
      presented,
    );
    if (check.kind !== 'no-match' && spec.prepare !== undefined) {
      try {
        await spec.prepare(account, factor);
      } catch (error) {
        if (codeProven(check, false)) await this.release(context, attempt);
        throw error;
      }
    }

    type Closed =
      | { readonly kind: 'done'; readonly value: T }
      | { readonly kind: 'failed'; readonly locked: boolean };
    let closed: Result<Closed, SignedInFactorRefusal>;
    // Whether the last run of the closing unit spent the code (a retried unit starts again).
    let spentInUnit = false;
    try {
      closed = await unitOfWork.run(
        market,
        async (): Promise<Result<Closed, SignedInFactorRefusal>> => {
          spentInUnit = false;
          const now = this.deps.clock.now();
          // The account's credential lock first, as every unit that changes a factor: the
          // success path (factor, then throttle) and the failure path (throttle, then factor)
          // then never interleave with each other (data design 3.3; Mojtaba, PR #162).
          if (!(await this.deps.accounts.lockCredential(market, accountId))) {
            return err({ code: 'session.invalid' });
          }
          const current = await this.deps.factors.findByAccount(market, accountId);
          if (
            current === null ||
            current.state.id !== factor.state.id ||
            !current.isActive ||
            spec.secretOf(current) !== secret
          ) {
            return err({ code: 'second-factor.unavailable' });
          }
          const spent = check.kind !== 'no-match' && (await spec.spend(current, check, now));
          spentInUnit = spent;
          if (!spent) {
            const lockedNow = await recordCodeFailure(
              { throttles, factors: this.deps.factors, outbox: this.deps.outbox },
              context,
              attempt,
              accountId,
              now,
            );
            // An `ok` outcome, so the counted failure and the lock commit (PN1).
            return ok({ kind: 'failed', locked: lockedNow });
          }
          await throttles.release(market, [attempt.reservation]);
          const reloaded = await this.deps.factors.findByAccount(market, accountId);
          if (reloaded === null) return err({ code: 'second-factor.unavailable' });
          const succeeded = await spec.succeed({ account, factor: reloaded, now });
          return succeeded.ok ? ok({ kind: 'done', value: succeeded.value }) : succeeded;
        },
      );
    } catch (error) {
      this.warn('identity.signed-in-factor.closing-failed', context);
      // Only a code proven correct gets its attempt back when the unit fails; a wrong code,
      // or a recovery code not spent, stays counted (HF2; Mojtaba and Hassan, PR #162).
      if (codeProven(check, spentInUnit)) await this.release(context, attempt);
      throw error;
    }
    if (!closed.ok) {
      await this.release(context, attempt);
      return closed;
    }
    if (closed.value.kind === 'failed') {
      return err(
        closed.value.locked
          ? { code: 'second-factor.locked', retryAfterSeconds: attempt.rule.blockMinutes * 60 }
          : { code: 'second-factor.invalid' },
      );
    }
    return ok(closed.value.value);
  }

  private async release(context: CallContext, attempt: ReservedAttempt): Promise<void> {
    try {
      await this.deps.unitOfWork.run(context.market, async () => {
        await this.deps.throttles.release(context.market, [attempt.reservation]);
        return ok(undefined);
      });
    } catch {
      this.warn('identity.signed-in-factor.release-unavailable', context);
    }
  }

  private warn(msg: string, context: CallContext): void {
    this.logger.warn({
      msg,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}
