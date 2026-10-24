import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac-drive/shared-kernel';
import type {
  CallContext,
  Clock,
  IdGenerator,
  Population,
  Result,
} from '@mondapac-drive/shared-kernel';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { Account } from '../../domain/account';
import type { OneTimeLink } from '../../domain/one-time-link';
import {
  checkNewPassword,
  MAX_PASSWORD_BYTES,
  type PasswordRejected,
} from '../../domain/password-policy';
import { reservationVerdict, type ThrottleReservation } from '../../domain/throttle';
import type { AccountRepository } from '../ports/account.repository';
import type { CommonPasswordList } from '../ports/common-password-list';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { LinkTokens } from '../ports/link-secrets';
import type { OneTimeLinkRepository } from '../ports/one-time-link.repository';
import type { PasswordHasher, PasswordHasherBusy } from '../ports/password-hasher';
import type { SecondFactorRepository } from '../ports/second-factor.repository';
import type { SessionRepository } from '../ports/session.repository';
import type { SignInChallengeRepository } from '../ports/sign-in-challenge.repository';
import type { ThrottleKeys } from '../ports/session-secrets';
import type { SignInRecordRepository } from '../ports/sign-in-record.repository';
import type { ThrottleCounter, ThrottleRepository } from '../ports/throttle.repository';
import type { SignInClient } from '../sign-in/sign-in-flow';
import type { FieldProblem } from '../field-problem';

export interface ResetPasswordInput {
  /** The population of the route: a link of the other population is refused (AC 19). */
  readonly population: 'admin' | 'courier';
  /** The token from the link's fragment, posted in the JSON body (identity design 6.6, I15). */
  readonly token: string;
  /** The new password. */
  readonly password: string;
  readonly client: SignInClient;
}

/** The password was replaced; the user signs in again (`ux.md` F3 step 4: no automatic sign-in). */
export type ResetPasswordOutput = { readonly code: 'password-changed' };

export type ResetPasswordFailure =
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] }
  | { readonly code: 'link.rejected' }
  | PasswordRejected
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | PasswordHasherBusy
  | { readonly code: 'access.unavailable' };

export interface ResetPasswordDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly links: OneTimeLinkRepository;
  readonly sessions: SessionRepository;
  /** HF11: the closing unit voids the account's open sign-in challenges. */
  readonly challenges: SignInChallengeRepository;
  /** Slice 7b item B: the closing unit clears a waiting replacement secret. */
  readonly factors: SecondFactorRepository;
  readonly throttles: ThrottleRepository;
  readonly records: SignInRecordRepository;
  readonly keys: ThrottleKeys;
  readonly linkTokens: LinkTokens;
  readonly outbox: OutboxWriter;
  readonly hasher: PasswordHasher;
  readonly commonPasswords: CommonPasswordList;
  readonly policy: IdentityMarketPolicy;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

const REJECTED = Object.freeze({ code: 'link.rejected' as const });
const UNAVAILABLE = Object.freeze({ code: 'access.unavailable' as const });

/** What the closing unit decided. */
type Closed =
  { readonly kind: 'reset'; readonly revokedSessions: number } | { readonly kind: 'refused' };

/**
 * Completing a password reset (identity design 3.5, 3.7, 6.5, 6.6; SEL-05, ACC-04, AC 8, AC 13,
 * AC 18, AC 19; `ux.md` F3 steps 3 and 4, A6; slice 4). Rule `anonymous`: the link's token is the
 * credential. Units, in order:
 *
 * 1. **Reservation unit** (as the link variant of sign-in, 6.3): `sign-in.origin` is counted, and
 *    the link is read by the hash of its token. A token that is malformed, unknown, used,
 *    expired, replaced by a newer request, of another purpose, of another population or Market,
 *    or of an account that is disabled or unverified, answers `link.rejected` (one answer for
 *    every cause, 8.6 row 1) and stays counted; nothing is hashed. Counter table unreachable:
 *    `access.unavailable` (fail closed, 6.8).
 * 2. The new password's rules (6.5), against the account's email and name; then its hash,
 *    outside any unit (HF12). A refusal or a full hash queue gives the reservation back and
 *    leaves the link usable.
 * 3. **Closing unit**, READ COMMITTED: the account's credential lock first
 *    (`lockCredential`; Hassan slice-2 N1), then the account read again; the domain refuses a
 *    disabled or unverified account (`Account.replacePassword`); the link is consumed by its
 *    conditional statement at the version read with the token (single use under concurrency;
 *    Hassan L1); the new hash is saved (one save, L2); **every** session of the account is
 *    revoked (`password-reset`); the sign-in counters of the address are cleared, which lifts a
 *    sign-in block (AC 13; `mail.account` stays); the origin reservation is given back; a sign-in
 *    record `password-reset` keeps the client's address and the correlation id (10.2, Hassan
 *    L3); `identity.account-password-changed.v1`
 *    (`reset`) drives the "password changed" mail (E13). No session is opened: the user signs in
 *    with the new password, so a second factor is never skipped (`ux.md` F3 step 4).
 *
 * A closing unit that throws gives the origin reservation back before the error goes on
 * (Mojtaba, slice 4). The closing unit also voids every open sign-in challenge of the account
 * (HF11; Hassan I2 (d)), and a reset never removes or bypasses the second factor (Hassan I2 (a)):
 * the next sign-in still asks for a code. It only drops a waiting replacement secret (slice 7b
 * item B). Slice 7b (item A) opens it to admins: the same sequence, and it clears only the two
 * sign-in counters, never `second-factor.account` (6.8; Hassan I-4).
 * The token and the passwords are never logged, stored or echoed.
 */
export class ResetPassword extends UseCase<
  ResetPasswordInput,
  ResetPasswordOutput,
  ResetPasswordFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.reset-password',
    rule: { kind: 'anonymous' },
  };

  readonly #logger = new Logger('ResetPassword');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ResetPasswordDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ResetPasswordInput,
  ): Promise<Result<ResetPasswordOutput, ResetPasswordFailure>> {
    const { market } = context;
    const { unitOfWork, throttles, links, accounts, keys, policy, hasher } = this.deps;
    const { population } = input;
    if (Buffer.byteLength(input.password, 'utf8') > MAX_PASSWORD_BYTES) {
      return err({ code: 'validation.failed', fields: [{ path: 'password', code: 'length' }] });
    }
    const tokenHash = this.deps.linkTokens.hashOf(input.token);
    const counter: ThrottleCounter = {
      kind: 'sign-in.origin',
      keyHash: keys.origin(market, input.client.origin),
      accountKey: null,
      rule: policy.signInThrottles(market).origin,
    };

    // 1. The reservation unit.
    let reserved: {
      readonly reservations: readonly ThrottleReservation[];
      readonly link: OneTimeLink | null;
      readonly account: Account | null;
      readonly throttled: number | null;
    };
    try {
      const run = await unitOfWork.run(market, async () => {
        const now = this.deps.clock.now();
        const reservations = await throttles.reserve(market, [counter], now);
        const link = tokenHash === null ? null : await links.findByTokenHash(market, tokenHash);
        let account =
          link !== null && link.usableFor('reset-password', now)
            ? await accounts.findById(market, link.state.accountId)
            : null;
        if (
          account !== null &&
          (account.state.population !== population ||
            account.state.status !== 'active' ||
            !account.isEmailVerified)
        ) {
          account = null;
        }
        const verdict = reservationVerdict(
          reservations.map((reservation) => ({ reservation, rule: counter.rule })),
          now,
        );
        return ok({
          reservations,
          link,
          account,
          throttled: verdict.allowed ? null : verdict.retryAfterSeconds,
        });
      });
      if (!run.ok) return err(UNAVAILABLE);
      reserved = run.value;
    } catch {
      this.log('identity.reset-password.throttle-unavailable', context, population, {});
      return err(UNAVAILABLE);
    }
    if (reserved.throttled !== null) {
      return err({ code: 'request.throttled', retryAfterSeconds: reserved.throttled });
    }
    const { reservations, link, account } = reserved;
    if (link === null || account === null) return err(REJECTED);

    // 2. The rules, then the hash outside any unit (HF12).
    const checked = checkNewPassword(
      input.password,
      policy.passwordRules(market),
      { email: account.state.email.normalized, displayName: account.state.displayName },
      (comparable) => this.deps.commonPasswords.isCommon(comparable),
    );
    if (!checked.ok) {
      return (await this.release(context, reservations)) ? err(checked.error) : err(UNAVAILABLE);
    }
    const hashed = await hasher.hash(input.password);
    if (!hashed.ok) {
      return (await this.release(context, reservations)) ? err(hashed.error) : err(UNAVAILABLE);
    }

    // 3. The closing unit.
    const accountId = account.state.id;
    const closed = await this.closing(context, reservations, () =>
      unitOfWork.run(market, async (): Promise<Result<Closed, never>> => {
        const now = this.deps.clock.now();
        const locked = await accounts.lockCredential(market, accountId);
        const current = locked ? await accounts.findById(market, accountId) : null;
        if (current === null || current.state.population !== population) {
          return ok({ kind: 'refused' });
        }
        // In memory first: an account disabled meanwhile leaves the link unused.
        const replaced = current.replacePassword({
          passwordHash: hashed.value,
          now,
          cause: 'reset',
        });
        if (!replaced.ok) return ok({ kind: 'refused' });
        // Bound to the link read with the token: a link requested again (or used) since then
        // has another version, and this use is refused (Hassan L1).
        if (!(await links.consume(market, link.state.id, link.state.version, now))) {
          return ok({ kind: 'refused' });
        }
        await accounts.save(market, current);
        // Throttle rows before challenge rows (data design 3.3; Mojtaba, PR #162).
        await throttles.clearAccount(
          market,
          keys.account(market, population, current.state.email.normalized),
        );
        await throttles.release(market, reservations);
        // HF11, Hassan I2 (d): a challenge opened with the old password can never complete.
        await this.deps.challenges.voidAllOf(market, accountId);
        // Slice 7b item B (3.6): a waiting replacement secret is dropped; the factor stays.
        const factor = await this.deps.factors.findByAccount(market, accountId);
        if (factor !== null && factor.clearReplacement()) {
          await this.deps.factors.save(market, factor);
        }
        const revokedSessions = await this.deps.sessions.revokeAllOf(
          market,
          accountId,
          'password-reset',
          now,
          null,
        );
        await this.deps.records.add(market, {
          id: this.deps.ids.next<'SignInRecord'>(),
          population,
          accountId,
          outcome: 'password-reset',
          occurredAt: now,
          address: input.client.address,
          sessionId: null,
          correlationId: context.correlationId,
        });
        await this.deps.outbox.append(context, current.pendingEvents);
        return ok({ kind: 'reset', revokedSessions });
      }),
    );
    if (!closed.ok) return err(UNAVAILABLE);
    if (closed.value.kind === 'refused') {
      this.log('identity.reset-password.link-rejected', context, population, {});
      return err(REJECTED);
    }
    this.log('identity.reset-password.done', context, population, {
      accountId,
      revokedSessions: closed.value.revokedSessions,
    });
    return ok({ code: 'password-changed' });
  }

  /**
   * Runs the closing unit. When it throws (a lock timeout, exhausted retries, a lost connection)
   * nothing of it was kept, so the origin reservation is given back, best effort, before the
   * error goes on to its usual answer (Mojtaba, slice 4).
   */
  private async closing<T>(
    context: CallContext,
    reservations: readonly ThrottleReservation[],
    run: () => Promise<Result<T, never>>,
  ): Promise<Result<T, never>> {
    try {
      return await run();
    } catch (error) {
      this.log('identity.reset-password.closing-failed', context, null, {});
      await this.release(context, reservations);
      throw error;
    }
  }

  /** Gives the reservation back (nothing was tried); false when its unit failed. */
  private async release(
    context: CallContext,
    reservations: readonly ThrottleReservation[],
  ): Promise<boolean> {
    try {
      const released = await this.deps.unitOfWork.run(context.market, async () => {
        await this.deps.throttles.release(context.market, reservations);
        return ok(undefined);
      });
      return released.ok;
    } catch {
      this.log('identity.reset-password.release-unavailable', context, null, {});
      return false;
    }
  }

  /** Ids, codes and counts only: never the address, the token or a password (P 12.3). */
  private log(
    msg: string,
    context: CallContext,
    population: Population | null,
    fields: Record<string, string | number>,
  ): void {
    this.#logger.log({
      msg,
      ...(population === null ? {} : { population }),
      ...fields,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}
