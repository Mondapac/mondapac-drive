import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac-drive/shared-kernel';
import type {
  CallContext,
  Clock,
  IdGenerator,
  Result,
  Temporal,
} from '@mondapac-drive/shared-kernel';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { Account } from '../../domain/account';
import {
  checkNewPassword,
  MAX_PASSWORD_BYTES,
  type PasswordRejected,
} from '../../domain/password-policy';
import type { Session } from '../../domain/session';
import {
  blockAfterFailure,
  reservationVerdict,
  type ThrottleReservation,
  type ThrottleRule,
} from '../../domain/throttle';
import type { AccountRepository } from '../ports/account.repository';
import type { CommonPasswordList } from '../ports/common-password-list';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { OneTimeLinkRepository } from '../ports/one-time-link.repository';
import type { PasswordHasher, PasswordHasherBusy } from '../ports/password-hasher';
import type { SessionRepository } from '../ports/session.repository';
import type { SignInChallengeRepository } from '../ports/sign-in-challenge.repository';
import type { SessionTokens, ThrottleKeys } from '../ports/session-secrets';
import type { SignInRecordRepository } from '../ports/sign-in-record.repository';
import type { ThrottleCounter, ThrottleRepository } from '../ports/throttle.repository';
import type { SecondFactorSecrets } from '../ports/second-factor-secrets';
import type { SecondFactorRepository } from '../ports/second-factor.repository';
import {
  checkPresentedCode,
  codeProven,
  parsePresentedCode,
  recordCodeFailure,
  reserveSecondFactor,
  secondFactorCounter,
  spendCode,
  type CodeCheck,
  type ReservedAttempt,
} from '../second-factor/code-check';
import type { SignInClient } from '../sign-in/sign-in-flow';
import type { FieldProblem } from '../field-problem';

export interface ChangePasswordInput {
  readonly currentPassword: string;
  readonly newPassword: string;
  /**
   * Required for an admin (Hassan I2 (b)): a code from the app or a recovery code. Ignored for a
   * courier, who has no second factor.
   */
  readonly code?: string;
  readonly client: SignInClient;
}

/**
 * The password was replaced and the current session rotated: its new token goes into the cookie
 * only (never a body or a log). `cookieMaxAgeSeconds` is what is left of the session's absolute
 * lifetime when its cookie outlives the browser, or null for a browser-session cookie (always,
 * in Drive). A courier's app takes the new token from the answer's body instead.
 */
export interface ChangePasswordOutput {
  readonly code: 'password-changed';
  readonly token: string;
  readonly cookieMaxAgeSeconds: number | null;
}

export type ChangePasswordFailure =
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] }
  | { readonly code: 'password.current-incorrect' }
  | PasswordRejected
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | PasswordHasherBusy
  | { readonly code: 'session.invalid' }
  | { readonly code: 'second-factor.invalid' }
  | { readonly code: 'second-factor.locked'; readonly retryAfterSeconds: number }
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' };

export interface ChangePasswordDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly sessions: SessionRepository;
  /** HF11: the closing unit voids the account's open sign-in challenges. */
  readonly challenges: SignInChallengeRepository;
  readonly links: OneTimeLinkRepository;
  readonly throttles: ThrottleRepository;
  readonly records: SignInRecordRepository;
  readonly keys: ThrottleKeys;
  readonly tokens: SessionTokens;
  readonly outbox: OutboxWriter;
  readonly hasher: PasswordHasher;
  readonly commonPasswords: CommonPasswordList;
  readonly policy: IdentityMarketPolicy;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Slice 7b: an admin's code (I2 (b)) and a waiting replacement cleared (item B). */
  readonly factors: SecondFactorRepository;
  readonly secrets: SecondFactorSecrets;
}

type Reserved = { readonly reservation: ThrottleReservation; readonly rule: ThrottleRule };

/** What the closing unit decided. */
type Closed =
  | { readonly kind: 'changed'; readonly session: Session; readonly revokedSessions: number }
  | {
      readonly kind: 'refused';
      readonly code:
        | 'access.unavailable'
        | 'password.current-incorrect'
        | 'session.invalid'
        | 'second-factor.invalid'
        | 'second-factor.locked';
    };

const UNAVAILABLE = Object.freeze({ code: 'access.unavailable' as const });

/**
 * A signed-in user changes the own password (identity design 3.5, 6.2, 6.5; brief flow «ج», AC
 * 18, AC 32; `ux.md` F3 step 5, B4; slice 4). Rule `own-resources`; a merchant's integration account is
 * refused. The account is the actor's;
 * nothing in the input names one.
 *
 * Decided by the design (6.5, 3.5, 6.2): the current password is required in the same request
 * (an admin needs a code too, Hassan I2 (b): that path comes with admin sign-in in slice 7b, so
 * an admin is refused until then); **every other session of the account is revoked**
 * (`password-changed`), and **the current session continues with a new token** (rotation), so a
 * token copied before the change stops working.
 *
 * Guessing the current password is throttled as sign-in is (HF1, 6.8): the reservation unit
 * counts `sign-in.account-origin`, `sign-in.account` and `sign-in.origin` for the account's
 * address before any hash, and a counter at its limit refuses without hashing; unreachable:
 * `access.unavailable`. A wrong current password stays counted and blocks a counter that reaches
 * its limit; a correct one gives the reservation back. The new password's rules (6.5) are
 * checked before the current one is verified, so a refused new password costs no hash.
 *
 * The closing unit (READ COMMITTED) takes the account's credential lock first (`lockCredential`;
 * Hassan slice-2 N1), reads the account again and refuses when the hash it verified is no longer
 * the stored one (a concurrent reset or change won). Then the current session is rotated (if it
 * was revoked meanwhile: `session.invalid`, nothing changes), the new hash saved, the other
 * sessions revoked, the reservation given back and `identity.account-password-changed.v1`
 * (`change`) recorded, which sends the "password changed" mail (E13). The same unit cancels the
 * account's unused reset link (Hassan L2), so a link requested before the change stops working,
 * and voids every open sign-in challenge of the account (HF11; Hassan I2 (d)).
 *
 * Every attempt that reaches the current password leaves a sign-in record (identity design 10.2;
 * Hassan L3) in the unit that decides it: `password.current-incorrect` or `password-changed`,
 * with the client's address, the session and the correlation id. A closing unit that throws gives
 * the reservation back before the error goes on (Mojtaba, slice 4).
 */
export class ChangePassword extends UseCase<
  ChangePasswordInput,
  ChangePasswordOutput,
  ChangePasswordFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.change-password',
    rule: { kind: 'own-resources' },
  };

  readonly #logger = new Logger('ChangePassword');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ChangePasswordDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ChangePasswordInput,
  ): Promise<Result<ChangePasswordOutput, ChangePasswordFailure>> {
    const { market, actor } = context;
    const { unitOfWork, accounts, throttles, keys, policy, hasher } = this.deps;
    // The gate admits only an authenticated actor under own-resources.
    // A merchant's integration account has a password nobody knows: its keys are issued instead.
    if (actor.kind !== 'authenticated' || actor.population === 'merchant') {
      return err({ code: 'access.denied' });
    }
    const population = actor.population;
    const tooLong = (['currentPassword', 'newPassword'] as const).filter(
      (field) => Buffer.byteLength(input[field], 'utf8') > MAX_PASSWORD_BYTES,
    );
    // Hassan I2 (b), slice 7b: an admin also presents a code (app or recovery code). A courier
    // has no second factor.
    const codeable = population === 'admin';
    const presented = codeable ? parsePresentedCode(input.code ?? '') : null;
    const fields: FieldProblem[] = tooLong.map((path) => ({ path, code: 'length' }));
    if (population === 'admin' && presented === null) fields.push({ path: 'code', code: 'format' });
    if (fields.length > 0) return err({ code: 'validation.failed', fields });
    const factorRule = codeable ? policy.secondFactorThrottle(market) : null;
    if (codeable && factorRule === null) return err(UNAVAILABLE);
    const rules = policy.signInThrottles(market);

    // 1. The reservation unit (HF1): count the attempt, read the actor's account.
    type Reservation = {
      readonly reserved: readonly Reserved[];
      readonly account: Account | null;
      readonly throttled: number | null;
      /** An admin's factor and its reserved `second-factor.account` attempt (HF2). */
      readonly factor: { readonly secret: string; readonly attempt: ReservedAttempt } | null;
      readonly factorLocked: number | null;
      /** An account with an active factor that presented no usable code (fails closed). */
      readonly codeMissing: boolean;
    };
    let reserved: Reservation;
    try {
      const run = await unitOfWork.run(market, async (): Promise<Result<Reservation, never>> => {
        const now = this.deps.clock.now();
        const account = await accounts.findById(market, actor.accountId);
        if (account === null) {
          return ok({
            reserved: [],
            account,
            throttled: null,
            factor: null,
            factorLocked: null,
            codeMissing: false,
          });
        }
        const email = account.state.email.normalized;
        const accountKey = keys.account(market, population, email);
        const counters: readonly ThrottleCounter[] = [
          {
            kind: 'sign-in.account-origin',
            keyHash: keys.accountOrigin(market, population, email, input.client.origin),
            accountKey,
            rule: rules.accountOrigin,
          },
          { kind: 'sign-in.account', keyHash: accountKey, accountKey, rule: rules.account },
          {
            kind: 'sign-in.origin',
            keyHash: keys.origin(market, input.client.origin),
            accountKey: null,
            rule: rules.origin,
          },
        ];
        const reservations = await throttles.reserve(market, counters, now);
        const reserved = reservations.map((reservation, index) => ({
          reservation,
          rule: counters[index]!.rule,
        }));
        const verdict = reservationVerdict(reserved, now);
        let factor: Reservation['factor'] = null;
        let factorLocked: number | null = null;
        let codeMissing = false;
        if (factorRule !== null && verdict.allowed) {
          const active = await this.deps.factors.findByAccount(market, actor.accountId);
          if (active !== null && active.isActive && presented === null) {
            // Unreachable for an admin (one without a code was refused above); fails closed:
            // nothing was tried, so no factor attempt is counted.
            codeMissing = true;
          } else if (active !== null && active.isActive) {
            const counter = secondFactorCounter(keys, market, population, email, factorRule);
            const attempt = await reserveSecondFactor(throttles, market, counter, now);
            if (attempt.kind === 'locked') factorLocked = attempt.retryAfterSeconds;
            else factor = { secret: active.state.secretCiphertext, attempt: attempt.reserved };
          }
        }
        return ok({
          reserved,
          account,
          throttled: verdict.allowed ? null : verdict.retryAfterSeconds,
          factor,
          factorLocked,
          codeMissing,
        });
      });
      if (!run.ok) return err(UNAVAILABLE);
      reserved = run.value;
    } catch {
      this.log('identity.change-password.throttle-unavailable', context, {});
      return err(UNAVAILABLE);
    }
    const { account } = reserved;
    // The session's account always exists (a cascade removes its sessions with it).
    if (account === null) return err({ code: 'session.invalid' });
    if (reserved.throttled !== null) {
      return err({ code: 'request.throttled', retryAfterSeconds: reserved.throttled });
    }
    const signInReservations = reserved.reserved.map((r) => r.reservation);
    if (reserved.codeMissing) {
      return this.releasing(context, signInReservations, {
        code: 'validation.failed' as const,
        fields: [{ path: 'code', code: 'required' }],
      });
    }
    const factorAttempt = reserved.factor?.attempt ?? null;
    if ((population === 'admin' || reserved.factorLocked !== null) && factorAttempt === null) {
      // HF2 lock, or an admin session without an active factor (3.5 forbids one): no change.
      await this.releasing(context, signInReservations, UNAVAILABLE);
      return reserved.factorLocked === null
        ? err({ code: 'access.denied' })
        : err({ code: 'second-factor.locked', retryAfterSeconds: reserved.factorLocked });
    }
    // Given back on every path where no code was tried.
    const reservations =
      factorAttempt === null
        ? signInReservations
        : [...signInReservations, factorAttempt.reservation];

    // 2. The new password's rules; the current password verified outside any unit; the hash.
    const checked = checkNewPassword(
      input.newPassword,
      policy.passwordRules(market),
      { email: account.state.email.normalized, displayName: account.state.displayName },
      (comparable) => this.deps.commonPasswords.isCommon(comparable),
    );
    if (!checked.ok) return this.releasing(context, reservations, checked.error);
    const verified = await hasher.verify(
      input.currentPassword,
      account.state.credential.passwordHash,
    );
    if (!verified.ok) return this.releasing(context, reservations, verified.error);
    if (!verified.value.matches) {
      // A wrong guess stays counted; a counter that reached its limit is blocked (6.8).
      const blocked = await this.failClosed(context, () =>
        unitOfWork.run(market, async () => {
          const now = this.deps.clock.now();
          const blocks = reserved.reserved.flatMap(({ reservation, rule }) => {
            const until = blockAfterFailure(reservation, rule, now);
            return until === null ? [] : [{ reservation, until }];
          });
          if (blocks.length > 0) await throttles.block(market, blocks);
          // No code was tried: the factor's attempt is given back.
          if (factorAttempt !== null) await throttles.release(market, [factorAttempt.reservation]);
          await this.record(context, input.client, 'password.current-incorrect', now);
          return ok(undefined);
        }),
      );
      if (!blocked) return err(UNAVAILABLE);
      this.log('identity.change-password.current-incorrect', context, {});
      return err({ code: 'password.current-incorrect' });
    }
    // An admin's code, outside any unit (I-2, I-3); spent in the closing unit (I-1).
    let check: CodeCheck | null = null;
    if (factorAttempt !== null && presented !== null && reserved.factor !== null) {
      check = await checkPresentedCode(
        { secrets: this.deps.secrets, clock: this.deps.clock },
        this.#logger,
        context,
        actor.accountId,
        reserved.factor.secret,
        presented,
      );
      if (check.kind === 'no-match') {
        const failed = await this.codeFailed(
          context,
          input.client,
          signInReservations,
          factorAttempt,
        );
        return err(failed);
      }
    }
    // Whether the last run of the closing unit spent the admin's code (a retried unit starts
    // again).
    let spentInUnit = false;
    /**
     * What is given back when the work after the code check fails and keeps nothing: the
     * sign-in counters (the current password matched) and the factor's attempt only for a code
     * proven correct (`codeProven`; Hassan, PR #162). A wrong recovery code stays counted.
     */
    const refundable = (): readonly ThrottleReservation[] =>
      factorAttempt === null || (check !== null && !codeProven(check, spentInUnit))
        ? signInReservations
        : reservations;
    const hashed = await hasher.hash(input.newPassword);
    if (!hashed.ok) return this.releasing(context, refundable(), hashed.error);
    const issued = this.deps.tokens.issue();
    const verifiedHash = account.state.credential.passwordHash;

    // 3. The closing unit.
    const closed = await this.closing(context, refundable, () =>
      unitOfWork.run(market, async (): Promise<Result<Closed, never>> => {
        spentInUnit = false;
        const now = this.deps.clock.now();
        const locked = await accounts.lockCredential(market, actor.accountId);
        const current = locked ? await accounts.findById(market, actor.accountId) : null;
        if (current === null) return ok({ kind: 'refused', code: 'session.invalid' });
        if (current.state.credential.passwordHash !== verifiedHash) {
          // A reset or another change committed since the current password was verified.
          await throttles.release(market, reservations);
          await this.record(context, input.client, 'password.current-incorrect', now);
          return ok({ kind: 'refused', code: 'password.current-incorrect' });
        }
        // An admin's code is spent here, after the credential lock (I-1): a replayed or
        // concurrent code stays counted and changes nothing else (HF2).
        if (factorAttempt !== null && check !== null) {
          const factor = await this.deps.factors.findByAccount(market, actor.accountId);
          const spent =
            factor !== null &&
            factor.isActive &&
            factor.state.secretCiphertext === reserved.factor!.secret &&
            (await spendCode(this.deps.factors, market, factor.state.id, check, now));
          spentInUnit = spent;
          if (!spent) {
            const lockedNow = await recordCodeFailure(
              { throttles, factors: this.deps.factors, outbox: this.deps.outbox },
              context,
              factorAttempt,
              actor.accountId,
              now,
            );
            await throttles.release(market, signInReservations);
            await this.record(context, input.client, 'second-factor.invalid', now);
            return ok({
              kind: 'refused',
              code: lockedNow ? 'second-factor.locked' : 'second-factor.invalid',
            });
          }
        }
        const replaced = current.replacePassword({
          passwordHash: hashed.value,
          now,
          cause: 'change',
        });
        if (!replaced.ok) return ok({ kind: 'refused', code: 'session.invalid' });
        const { sessions } = this.deps;
        // 6.2: the current session continues with a new token; revoked meanwhile, nothing changes.
        if (!(await sessions.rotate(market, actor.sessionId, actor.accountId, issued.tokenHash))) {
          await throttles.release(market, reservations);
          return ok({ kind: 'refused', code: 'session.invalid' });
        }
        const session = await sessions.findById(market, actor.sessionId);
        if (session === null) return ok({ kind: 'refused', code: 'session.invalid' });
        await accounts.save(market, current);
        // Hassan L2: a reset link requested before the change stops working with it.
        await this.deps.links.cancelUnused(market, actor.accountId, 'reset-password');
        // Throttle rows before challenge rows (data design 3.3; Mojtaba, PR #162).
        await throttles.release(market, reservations);
        // HF11, Hassan I2 (d): a challenge opened with the old password can never complete.
        await this.deps.challenges.voidAllOf(market, actor.accountId);
        // Slice 7b item B (3.6): a waiting replacement secret is dropped; the factor stays.
        const factor = await this.deps.factors.findByAccount(market, actor.accountId);
        if (factor !== null && factor.clearReplacement()) {
          await this.deps.factors.save(market, factor);
        }
        const revokedSessions = await sessions.revokeAllOf(
          market,
          actor.accountId,
          'password-changed',
          now,
          actor.sessionId,
        );
        await this.record(context, input.client, 'password-changed', now);
        await this.deps.outbox.append(context, current.pendingEvents);
        return ok({ kind: 'changed', session, revokedSessions });
      }),
    );
    if (!closed.ok) return err(UNAVAILABLE);
    const outcome = closed.value;
    if (outcome.kind === 'refused') {
      this.log('identity.change-password.refused', context, { reason: outcome.code });
      if (outcome.code === 'second-factor.locked') {
        return err({
          code: outcome.code,
          retryAfterSeconds: (factorAttempt?.rule.blockMinutes ?? 0) * 60,
        });
      }
      return err({ code: outcome.code });
    }
    this.log('identity.change-password.done', context, {
      revokedSessions: outcome.revokedSessions,
    });
    return ok({
      code: 'password-changed',
      token: issued.token,
      cookieMaxAgeSeconds: this.cookieMaxAge(),
    });
  }

  /**
   * The cookie of the rotated session (identity design 6.1): an admin's is never persistent
   * (Hassan L1, PR #162), and a courier's token is no cookie at all (the app keeps it), so the
   * answer is always a browser-session cookie.
   */
  private cookieMaxAge(): null {
    return null;
  }

  /**
   * Runs the closing unit. When it throws (a lock timeout, exhausted retries, a lost connection)
   * nothing of it was kept, so the refundable reservations (read after the unit: a code proven
   * correct only) are given back, best effort, before the error goes on to its usual answer
   * (Mojtaba, slice 4; Hassan, PR #162).
   */
  private async closing<T>(
    context: CallContext,
    refundable: () => readonly ThrottleReservation[],
    run: () => Promise<Result<T, never>>,
  ): Promise<Result<T, never>> {
    try {
      return await run();
    } catch (error) {
      this.log('identity.change-password.closing-failed', context, {});
      const reservations = refundable();
      await this.failClosed(context, () =>
        this.deps.unitOfWork.run(context.market, async () => {
          await this.deps.throttles.release(context.market, reservations);
          return ok(undefined);
        }),
      );
      throw error;
    }
  }

  /**
   * One sign-in record of the password change (identity design 10.2; Hassan L3): the actor's
   * account and session, the client's address and the correlation id; never a password.
   */
  private async record(
    context: CallContext,
    client: SignInClient,
    outcome: 'password.current-incorrect' | 'password-changed' | 'second-factor.invalid',
    now: Temporal.Instant,
  ): Promise<void> {
    const actor = context.actor;
    if (actor.kind !== 'authenticated') return;
    await this.deps.records.add(context.market, {
      id: this.deps.ids.next<'SignInRecord'>(),
      population: actor.population,
      accountId: actor.accountId,
      outcome,
      occurredAt: now,
      address: client.address,
      sessionId: actor.sessionId,
      correlationId: context.correlationId,
    });
  }

  /**
   * An admin's code matched nothing (HF2): the attempt stays counted, the one that reaches the
   * limit blocks the counter and locks the factor; the password was right, so the sign-in
   * reservation is given back. Answers the refusal.
   */
  private async codeFailed(
    context: CallContext,
    client: SignInClient,
    signInReservations: readonly ThrottleReservation[],
    attempt: ReservedAttempt,
  ): Promise<ChangePasswordFailure> {
    const actor = context.actor;
    if (actor.kind !== 'authenticated') return { code: 'access.denied' };
    let lockedNow = false;
    const done = await this.failClosed(context, () =>
      this.deps.unitOfWork.run(context.market, async () => {
        const now = this.deps.clock.now();
        lockedNow = await recordCodeFailure(
          { throttles: this.deps.throttles, factors: this.deps.factors, outbox: this.deps.outbox },
          context,
          attempt,
          actor.accountId,
          now,
        );
        await this.deps.throttles.release(context.market, signInReservations);
        await this.record(context, client, 'second-factor.invalid', now);
        return ok(undefined);
      }),
    );
    if (!done) return UNAVAILABLE;
    this.log('identity.change-password.code-invalid', context, {});
    return lockedNow
      ? { code: 'second-factor.locked', retryAfterSeconds: attempt.rule.blockMinutes * 60 }
      : { code: 'second-factor.invalid' };
  }

  /** Gives the reservation back (nothing was guessed) and answers `failure`. */
  private async releasing<F extends ChangePasswordFailure>(
    context: CallContext,
    reservations: readonly ThrottleReservation[],
    failure: F,
  ): Promise<Result<never, F | typeof UNAVAILABLE>> {
    const released = await this.failClosed(context, () =>
      this.deps.unitOfWork.run(context.market, async () => {
        await this.deps.throttles.release(context.market, reservations);
        return ok(undefined);
      }),
    );
    return err(released ? failure : UNAVAILABLE);
  }

  /** Runs a counter unit; false when it failed or threw (fail closed, 6.8). */
  private async failClosed(
    context: CallContext,
    run: () => Promise<Result<void, never>>,
  ): Promise<boolean> {
    try {
      return (await run()).ok;
    } catch {
      this.log('identity.change-password.unit-unavailable', context, {});
      return false;
    }
  }

  /** Ids, codes and counts only: never the address, a token or a password (P 12.3). */
  private log(msg: string, context: CallContext, fields: Record<string, string | number>): void {
    const actor = context.actor;
    this.#logger.log({
      msg,
      ...fields,
      ...(actor.kind === 'authenticated'
        ? { accountId: actor.accountId, population: actor.population }
        : {}),
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}
