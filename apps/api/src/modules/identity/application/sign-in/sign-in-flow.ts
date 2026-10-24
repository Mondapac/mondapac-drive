import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac-drive/shared-kernel';
import type {
  CallContext,
  Clock,
  Id,
  IdGenerator,
  Result,
  Temporal,
} from '@mondapac-drive/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { Account } from '../../domain/account';
import type { DeviceCode } from '../../domain/device';
import type { EmailAddress } from '../../domain/email-address';
import { openSession, type Session } from '../../domain/session';
import {
  blockAfterFailure,
  reservationVerdict,
  type ThrottleReservation,
  type ThrottleRule,
} from '../../domain/throttle';
import type { AccountRepository } from '../ports/account.repository';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { PasswordHasher, PasswordHasherBusy } from '../ports/password-hasher';
import type { SessionRepository } from '../ports/session.repository';
import type { SessionTokens, ThrottleKeys } from '../ports/session-secrets';
import type { SignInRecordRepository } from '../ports/sign-in-record.repository';
import type { ThrottleCounter, ThrottleRepository } from '../ports/throttle.repository';
import type {
  AdminSecondStep,
  AdminSecondStepOutcome,
  AdminSecondStepPolicy,
} from './admin-second-step';

/** Where the request came from, as resolved per ADR-0037 (never a forwarded header). */
export interface SignInClient {
  /** The IPv4 address or the IPv6 /64: the key of the origin counters (HF3). */
  readonly origin: string;
  /** The full address, stored in the sign-in record (10.2). */
  readonly address: string;
  /**
   * The coarse device of the request (profile package 4), kept on a session it opens; absent
   * or null when unknown. Never the raw User-Agent.
   */
  readonly device?: DeviceCode | null;
}

/** The populations that sign in with a password: a courier alone, an admin with a factor. */
type FlowPopulation = 'admin' | 'courier';

/**
 * A new courier session. The token goes to the courier app in the answer's body only (it sends
 * it back as `Authorization: Bearer`), never a log.
 */
export interface SignedIn {
  readonly code: 'signed-in';
  readonly token: string;
  readonly absoluteLifetimeSeconds: number;
  readonly idleTimeoutSeconds: number;
}

export type SignInRefusal =
  | { readonly code: 'credentials.invalid' }
  | { readonly code: 'email-verification-required' }
  | { readonly code: 'account.disabled' }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | PasswordHasherBusy
  | { readonly code: 'access.unavailable' };

export interface SignInDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly sessions: SessionRepository;
  readonly throttles: ThrottleRepository;
  readonly records: SignInRecordRepository;
  readonly hasher: PasswordHasher;
  readonly tokens: SessionTokens;
  readonly keys: ThrottleKeys;
  readonly policy: IdentityMarketPolicy;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

type Reserved = { readonly reservation: ThrottleReservation; readonly rule: ThrottleRule };

type Refused =
  | 'credentials.invalid'
  | 'email-verification-required'
  | 'account.disabled'
  | 'access.unavailable';

/** What the closing unit decided. */
type Closed =
  | { readonly kind: 'signed-in'; readonly session: Session }
  | { readonly kind: 'admin-step'; readonly step: AdminSecondStepOutcome }
  | { readonly kind: 'refused'; readonly code: Refused };

/** What the reservation and closing units of one attempt produce, for every population. */
type Outcome =
  | { readonly kind: 'signed-in'; readonly value: SignedIn }
  | { readonly kind: 'admin-step'; readonly step: AdminSecondStepOutcome };

const UNAVAILABLE = Object.freeze({ code: 'access.unavailable' as const });

/**
 * The sign-in sequence of identity design 6.3 (copied from the marketplace, reduced to Drive's
 * two password populations): a courier from the app, and an admin, whose password step ends at
 * step 5 ({@link AdminSecondStep}) and never in a session. Not a use case itself: each use case
 * declares its own access rule and calls {@link run} or {@link runAdmin} from its `handle`. The
 * population is fixed per instance: the account is looked up within it, so another
 * population's address answers `credentials.invalid` (AC 3). A merchant never signs in: its API
 * keys are issued by an operator.
 *
 * 1. The generic per-origin limit ran before any identity code (the platform's rate limiter).
 * 2. **Reservation unit** (HF1): one short read-write unit counts the attempt on the three
 *    sign-in counters and reads the account by Market, population and normalised email. A
 *    counter at its threshold refuses the attempt without hashing. Counters unreachable: fail
 *    closed.
 * 3. **The password is verified outside any unit**, against a dummy hash when there is no
 *    account, so both paths cost one hash (HF12).
 * 4. **Closing unit** (HF11): after a correct password, takes the account's credential lock
 *    (`AccountRepository.lockCredential`) and re-reads the account, so a password reset or
 *    change that commits meanwhile is either seen here or revokes the session this unit opens.
 *    A wrong password, an unknown address or a credential that changed since it was verified is
 *    `credentials.invalid`; the failure stays counted and a counter that reached its limit is
 *    blocked. A correct password releases the reservation. An unverified email is
 *    `email-verification-required` (Hassan I5) and a disabled account `account.disabled`. Then a
 *    hash with older parameters is replaced and a courier session (transport `bearer`) with a
 *    new token is created. Every attempt writes one sign-in record (never the email).
 *
 * Refusals are `ok` outcomes of their units, so the counters, the record and the block commit
 * (PN1).
 */
export class SignInFlow {
  readonly #logger = new Logger('SignIn');

  constructor(
    private readonly population: FlowPopulation,
    private readonly deps: SignInDependencies,
    private readonly adminStep: AdminSecondStep | null = null,
  ) {
    if ((population === 'admin') !== (adminStep !== null)) {
      throw new Error('SignInFlow: the admin step is for, and only for, the admin population');
    }
  }

  /** A courier's sign-in: a session, or a refusal. */
  async run(
    context: CallContext,
    email: EmailAddress,
    password: string,
    client: SignInClient,
  ): Promise<Result<SignedIn, SignInRefusal>> {
    if (this.population === 'admin') {
      throw new Error('SignInFlow: an admin signs in through runAdmin (AC 10)');
    }
    const outcome = await this.#run(context, email, password, client, null);
    if (!outcome.ok) return outcome;
    if (outcome.value.kind !== 'signed-in') throw new Error('SignInFlow: a factor step');
    return ok(outcome.value.value);
  }

  /**
   * An admin's password step (identity design 6.3 steps 1 to 5): the outcome of
   * {@link AdminSecondStep}, or a refusal of steps 1 to 4. `adminPolicy` was read before any unit.
   */
  async runAdmin(
    context: CallContext,
    email: EmailAddress,
    password: string,
    client: SignInClient,
    adminPolicy: AdminSecondStepPolicy,
  ): Promise<Result<AdminSecondStepOutcome, SignInRefusal>> {
    if (this.population !== 'admin') throw new Error('SignInFlow: runAdmin is for admins');
    const outcome = await this.#run(context, email, password, client, adminPolicy);
    if (!outcome.ok) return outcome;
    if (outcome.value.kind !== 'admin-step') throw new Error('SignInFlow: an admin session');
    return ok(outcome.value.step);
  }

  async #run(
    context: CallContext,
    email: EmailAddress,
    password: string,
    client: SignInClient,
    adminPolicy: AdminSecondStepPolicy | null,
  ): Promise<Result<Outcome, SignInRefusal>> {
    const { market } = context;
    const { policy, keys, unitOfWork, throttles, accounts, hasher } = this.deps;
    const population = this.population;
    if (population === 'admin' && adminPolicy === null) {
      throw new Error('SignInFlow: an admin signs in with the admin policy');
    }
    // An admin's password opens no session; its lifetime is read where the session is opened.
    const lifetime = population === 'admin' ? null : policy.sessionLifetime(market, population);
    if (population !== 'admin' && lifetime === null) return err(UNAVAILABLE);
    const rules = policy.signInThrottles(market);
    const accountKey = keys.account(market, population, email.normalized);
    const counters: readonly ThrottleCounter[] = [
      {
        kind: 'sign-in.account-origin',
        keyHash: keys.accountOrigin(market, population, email.normalized, client.origin),
        accountKey,
        rule: rules.accountOrigin,
      },
      { kind: 'sign-in.account', keyHash: accountKey, accountKey, rule: rules.account },
      {
        kind: 'sign-in.origin',
        keyHash: keys.origin(market, client.origin),
        accountKey: null,
        rule: rules.origin,
      },
    ];

    // Step 2: the reservation unit (HF1).
    let reservation: {
      readonly reserved: readonly Reserved[];
      readonly account: Account | null;
      readonly refusal: {
        readonly code: 'request.throttled';
        readonly retryAfterSeconds: number;
      } | null;
    };
    try {
      const run = await unitOfWork.run(market, async () => {
        const now = this.deps.clock.now();
        const reservations = await throttles.reserve(market, counters, now);
        const account = await accounts.findByEmail(market, population, email.normalized);
        const reserved = reservations.map((r, index) => ({
          reservation: r,
          rule: counters[index]!.rule,
        }));
        const verdict = reservationVerdict(reserved, now);
        const refusal = !verdict.allowed
          ? { code: 'request.throttled' as const, retryAfterSeconds: verdict.retryAfterSeconds }
          : null;
        if (refusal !== null) {
          await this.record(context, client, account?.state.id ?? null, refusal.code, null, now);
        }
        return ok({ reserved, account, refusal });
      });
      if (!run.ok) return err(UNAVAILABLE);
      reservation = run.value;
    } catch {
      // Fail closed: the counters could not be evaluated, so nothing is hashed (6.8).
      this.#logger.warn({
        msg: 'identity.sign-in.throttle-unavailable',
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return err(UNAVAILABLE);
    }
    if (reservation.refusal !== null) return err(reservation.refusal);
    const { reserved, account } = reservation;

    // Step 3: the hash check, outside any unit (HF12).
    const verified = await hasher.verify(
      password,
      account === null ? null : account.state.credential.passwordHash,
    );
    if (!verified.ok) {
      // Nothing was verified: the reservation is given back.
      const released = await this.#failClosed(context, 'release', () =>
        unitOfWork.run(market, async () => {
          await throttles.release(
            market,
            reserved.map((r) => r.reservation),
          );
          await this.record(
            context,
            client,
            account?.state.id ?? null,
            'request.busy',
            null,
            this.deps.clock.now(),
          );
          return ok(undefined);
        }),
      );
      if (!released.ok) return err(UNAVAILABLE);
      return err(verified.error);
    }
    const matches = account !== null && verified.value.matches;
    // Slow work before the closing unit: the new hash (older parameters) and the token.
    const rehashed = matches && verified.value.needsRehash ? await hasher.hash(password) : null;
    // An admin gets a challenge token in place of a session token (6.3 step 5).
    const issued = !matches
      ? null
      : this.adminStep !== null
        ? this.adminStep.issueToken()
        : this.deps.tokens.issue();

    // Step 4: the closing unit (HF11).
    const closed = await this.#failClosed(context, 'closing', () =>
      unitOfWork.run(market, async (): Promise<Result<Closed, never>> => {
        const now = this.deps.clock.now();
        // Hassan slice-2 N1: before the stored hash is compared, the account's credential lock
        // is taken (one statement that changes no value), and the account is read after it. A
        // password reset or change takes the same lock before it replaces the hash and revokes
        // the sessions, so the two serialise at READ COMMITTED: either this unit commits its
        // session first and the change revokes it, or this unit reads the new hash and refuses.
        // A failed attempt takes no lock.
        let current: Account | null = null;
        if (matches && account !== null && issued !== null) {
          const locked = await accounts.lockCredential(market, account.state.id);
          current = locked ? await accounts.findById(market, account.state.id) : null;
        }
        if (
          !matches ||
          account === null ||
          issued === null ||
          current === null ||
          current.state.credential.passwordHash !== account.state.credential.passwordHash
        ) {
          const blocks = reserved.flatMap(({ reservation: r, rule }) => {
            const until = blockAfterFailure(r, rule, now);
            return until === null ? [] : [{ reservation: r, until }];
          });
          if (blocks.length > 0) await throttles.block(market, blocks);
          await this.record(
            context,
            client,
            account?.state.id ?? null,
            'credentials.invalid',
            null,
            now,
          );
          return ok({ kind: 'refused', code: 'credentials.invalid' });
        }
        await throttles.release(
          market,
          reserved.map((r) => r.reservation),
        );
        const accountId = current.state.id;
        const refuse = async (code: Refused): Promise<Result<Closed, never>> => {
          await this.record(context, client, accountId, code, null, now);
          return ok({ kind: 'refused', code });
        };
        if (!current.isEmailVerified) {
          return refuse('email-verification-required');
        }
        // Step 5 for an admin (slice 7b), before the account's state is told (6.3): a password
        // alone never opens an admin session (AC 10).
        if (this.adminStep !== null && adminPolicy !== null) {
          if (rehashed !== null && rehashed.ok) current.rehashPassword(rehashed.value);
          if (current.state.version !== current.persistedVersion) {
            await accounts.save(market, current);
          }
          const step = await this.adminStep.decide(context, current, adminPolicy, issued, now);
          await this.record(context, client, accountId, step.code, null, now);
          return ok({ kind: 'admin-step', step });
        }
        if (current.state.status !== 'active') return refuse('account.disabled');
        if (rehashed !== null && rehashed.ok) current.rehashPassword(rehashed.value);
        if (current.state.version !== current.persistedVersion) {
          await accounts.save(market, current);
        }
        if (lifetime === null) throw new Error('SignInFlow: no lifetime for a session');
        const session = openSession({
          id: this.deps.ids.next<'Session'>(),
          marketId: market.marketId,
          accountId,
          population,
          transport: 'bearer',
          device: client.device ?? null,
          lifetime,
          now,
        });
        await this.deps.sessions.add(market, session, issued.tokenHash);
        await this.record(context, client, accountId, 'signed-in', session.id, now);
        return ok({ kind: 'signed-in', session });
      }),
    );
    if (!closed.ok) return err(UNAVAILABLE);
    const outcome = closed.value;
    if (outcome.kind === 'refused') return err({ code: outcome.code });
    if (outcome.kind === 'admin-step') return ok({ kind: 'admin-step', step: outcome.step });
    return ok({
      kind: 'signed-in',
      value: {
        code: 'signed-in',
        token: issued!.token,
        absoluteLifetimeSeconds: lifetime!.absoluteLifetimeSeconds,
        idleTimeoutSeconds: lifetime!.idleTimeoutSeconds,
      },
    });
  }

  /**
   * Runs a unit after the reservation and answers access.unavailable when it throws, like the
   * reservation unit does (6.8): no session is opened and the attempt stays counted.
   */
  async #failClosed<T, E>(
    context: CallContext,
    unit: 'release' | 'closing',
    run: () => Promise<Result<T, E>>,
  ): Promise<Result<T, E | 'unavailable'>> {
    try {
      return await run();
    } catch {
      this.#logger.warn({
        msg: 'identity.sign-in.unit-unavailable',
        unit,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      return err('unavailable');
    }
  }

  /** One sign-in record (identity design 10.2): never the typed email or a token. */
  private async record(
    context: CallContext,
    client: SignInClient,
    accountId: Id<'Account'> | null,
    outcome: string,
    sessionId: Id<'Session'> | null,
    now: Temporal.Instant,
  ): Promise<void> {
    await this.deps.records.add(context.market, {
      id: this.deps.ids.next<'SignInRecord'>(),
      population: this.population,
      accountId,
      outcome,
      occurredAt: now,
      address: client.address,
      sessionId,
      correlationId: context.correlationId,
    });
  }
}
