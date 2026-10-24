import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac-drive/shared-kernel';
import type {
  CallContext,
  Clock,
  IdGenerator,
  Result,
  Temporal,
} from '@mondapac-drive/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { Account } from '../../domain/account';
import type { OneTimeLink } from '../../domain/one-time-link';
import { encodeBase32, otpauthUri } from '../../domain/otpauth';
import { MAX_PASSWORD_BYTES } from '../../domain/password-policy';
import { SecondFactor } from '../../domain/second-factor';
import { issueChallenge } from '../../domain/sign-in-challenge';
import {
  blockAfterFailure,
  reservationVerdict,
  type ThrottleReservation,
  type ThrottleRule,
} from '../../domain/throttle';
import type { AccountRepository } from '../ports/account.repository';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { LinkTokens } from '../ports/link-secrets';
import type { OneTimeLinkRepository } from '../ports/one-time-link.repository';
import type { PasswordHasher, PasswordHasherBusy } from '../ports/password-hasher';
import type { OpaqueTokens } from '../ports/second-factor-tokens';
import type { SecondFactorSecrets } from '../ports/second-factor-secrets';
import type { SecondFactorRepository } from '../ports/second-factor.repository';
import type { ThrottleKeys } from '../ports/session-secrets';
import type { SignInChallengeRepository } from '../ports/sign-in-challenge.repository';
import type { SignInRecordRepository } from '../ports/sign-in-record.repository';
import type { ThrottleCounter, ThrottleRepository } from '../ports/throttle.repository';
import type { SignInClient } from '../sign-in/sign-in-flow';
import type { FieldProblem } from '../field-problem';

export interface StartSecondFactorEnrolmentInput {
  /** The token from the fragment of the mailed `enrol-second-factor` link. */
  readonly token: string;
  readonly password: string;
  readonly client: SignInClient;
}

/**
 * A pending factor exists. The secret is shown once, here, as base32 text and inside the
 * `otpauth://` URI for the panel's QR code (drawn by the panel, never a remote service: 7.1);
 * the challenge's token is posted back with the first code.
 */
export interface StartSecondFactorEnrolmentOutput {
  readonly code: 'second-factor-enrolment-started';
  readonly challengeToken: string;
  readonly expiresAt: Temporal.Instant;
  readonly secret: string;
  readonly otpauthUri: string;
}

export type StartSecondFactorEnrolmentFailure =
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] }
  | { readonly code: 'link.rejected' }
  | { readonly code: 'credentials.invalid' }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | PasswordHasherBusy
  | { readonly code: 'access.unavailable' };

export interface StartSecondFactorEnrolmentDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly links: OneTimeLinkRepository;
  readonly factors: SecondFactorRepository;
  readonly challenges: SignInChallengeRepository;
  readonly throttles: ThrottleRepository;
  readonly records: SignInRecordRepository;
  readonly keys: ThrottleKeys;
  readonly linkTokens: LinkTokens;
  readonly challengeTokens: OpaqueTokens;
  readonly secrets: SecondFactorSecrets;
  readonly hasher: PasswordHasher;
  readonly policy: IdentityMarketPolicy;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

type Reserved = { readonly reservation: ThrottleReservation; readonly rule: ThrottleRule };

const REJECTED = Object.freeze({ code: 'link.rejected' as const });
const INVALID = Object.freeze({ code: 'credentials.invalid' as const });
const UNAVAILABLE = Object.freeze({ code: 'access.unavailable' as const });

/**
 * Starts an admin's enrolment from the mailed link (identity design 3.6 `none` → `pending`, HF6,
 * 7.1, 7.5; AC 22; slice 7b item F). Rule `anonymous`: the link's token and the password bind the
 * account; a password alone never starts an enrolment (HF6).
 *
 * 1. **Reservation unit** (HF1): the link by the hash of its token, usable for
 *    `enrol-second-factor`, of an active admin account; the sign-in counters of the address and
 *    origin are reserved as at sign-in (only `sign-in.origin` when the link is refused, which
 *    answers `link.rejected` without hashing). A counter at its limit: `request.throttled`.
 * 2. The password is verified outside any unit (HF12); a wrong one stays counted and blocks a
 *    counter at its limit (`credentials.invalid`). A new 160-bit secret is made and sealed under
 *    the account's key, and the enrolment challenge's token minted, all outside any unit.
 * 3. **Closing unit**: the credential lock, the account read again and the hash compared (HF11).
 *    An active factor refuses the link (no enrolment over an active factor; 3.6). A stale pending
 *    factor is removed, never an active one, and the new one added in the same unit (item F);
 *    the link is consumed at the version read (single use); an enrolment challenge (purpose
 *    `second-factor-enrolment`, bound to the credential's time) is stored; the reservation is
 *    given back; a sign-in record `second-factor-enrolment-started`.
 *
 * The secret, the token and the password are never logged, stored in clear or put in an event.
 */
export class StartSecondFactorEnrolment extends UseCase<
  StartSecondFactorEnrolmentInput,
  StartSecondFactorEnrolmentOutput,
  StartSecondFactorEnrolmentFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.start-second-factor-enrolment',
    rule: { kind: 'anonymous' },
  };

  readonly #logger = new Logger('StartSecondFactorEnrolment');

  constructor(
    gate: UseCaseGate,
    private readonly deps: StartSecondFactorEnrolmentDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: StartSecondFactorEnrolmentInput,
  ): Promise<Result<StartSecondFactorEnrolmentOutput, StartSecondFactorEnrolmentFailure>> {
    const { market } = context;
    const { unitOfWork, throttles, keys, policy } = this.deps;
    if (Buffer.byteLength(input.password, 'utf8') > MAX_PASSWORD_BYTES) {
      return err({ code: 'validation.failed', fields: [{ path: 'password', code: 'length' }] });
    }
    const challengePolicy = policy.challengePolicy(market);
    if (challengePolicy === null) return err(UNAVAILABLE);
    const rules = policy.signInThrottles(market);
    const tokenHash = this.deps.linkTokens.hashOf(input.token);
    const originCounter: ThrottleCounter = {
      kind: 'sign-in.origin',
      keyHash: keys.origin(market, input.client.origin),
      accountKey: null,
      rule: rules.origin,
    };

    // 1. The reservation unit.
    let reserved: {
      readonly reserved: readonly Reserved[];
      readonly link: OneTimeLink | null;
      readonly account: Account | null;
      readonly throttled: number | null;
    };
    try {
      const run = await unitOfWork.run(market, async () => {
        const now = this.deps.clock.now();
        const link =
          tokenHash === null ? null : await this.deps.links.findByTokenHash(market, tokenHash);
        let account =
          link !== null && link.usableFor('enrol-second-factor', now)
            ? await this.deps.accounts.findById(market, link.state.accountId)
            : null;
        if (
          account !== null &&
          (account.state.population !== 'admin' || account.state.status !== 'active')
        ) {
          account = null;
        }
        const counters: readonly ThrottleCounter[] =
          account === null
            ? [originCounter]
            : [
                {
                  kind: 'sign-in.account-origin',
                  keyHash: keys.accountOrigin(
                    market,
                    'admin',
                    account.state.email.normalized,
                    input.client.origin,
                  ),
                  accountKey: keys.account(market, 'admin', account.state.email.normalized),
                  rule: rules.accountOrigin,
                },
                {
                  kind: 'sign-in.account',
                  keyHash: keys.account(market, 'admin', account.state.email.normalized),
                  accountKey: keys.account(market, 'admin', account.state.email.normalized),
                  rule: rules.account,
                },
                originCounter,
              ];
        const reservations = await throttles.reserve(market, counters, now);
        const reserved = reservations.map((reservation, index) => ({
          reservation,
          rule: counters[index]!.rule,
        }));
        const verdict = reservationVerdict(reserved, now);
        return ok({
          reserved,
          link,
          account,
          throttled: verdict.allowed ? null : verdict.retryAfterSeconds,
        });
      });
      if (!run.ok) return err(UNAVAILABLE);
      reserved = run.value;
    } catch {
      this.log('identity.second-factor-enrolment.throttle-unavailable', context, {});
      return err(UNAVAILABLE);
    }
    if (reserved.throttled !== null) {
      return err({ code: 'request.throttled', retryAfterSeconds: reserved.throttled });
    }
    const { link, account } = reserved;
    const reservations = reserved.reserved.map((r) => r.reservation);
    if (link === null || account === null) {
      this.log('identity.second-factor-enrolment.link-rejected', context, {});
      return err(REJECTED);
    }
    const accountId = account.state.id;

    // 2. The password, outside any unit; then the secret and the challenge's token.
    const verified = await this.deps.hasher.verify(
      input.password,
      account.state.credential.passwordHash,
    );
    if (!verified.ok) {
      return (await this.release(context, reservations)) ? err(verified.error) : err(UNAVAILABLE);
    }
    if (!verified.value.matches) {
      const blocked = await this.quietly(context, () =>
        unitOfWork.run(market, async () => {
          const now = this.deps.clock.now();
          const blocks = reserved.reserved.flatMap(({ reservation, rule }) => {
            const until = blockAfterFailure(reservation, rule, now);
            return until === null ? [] : [{ reservation, until }];
          });
          if (blocks.length > 0) await throttles.block(market, blocks);
          await this.record(context, input.client, accountId, INVALID.code, now);
          return ok(undefined);
        }),
      );
      return err(blocked ? INVALID : UNAVAILABLE);
    }
    const secret = this.deps.secrets.newSecret();
    const issued = this.deps.challengeTokens.issue();
    let sealed: string;
    let shown: { readonly secret: string; readonly uri: string };
    try {
      sealed = await this.deps.secrets.seal(market, accountId, secret);
      const encoded = encodeBase32(secret);
      shown = {
        secret: encoded,
        uri: otpauthUri({
          issuer: policy.mailSender(market).name,
          accountName: account.state.email.typed,
          secret,
        }),
      };
    } catch (error) {
      await this.release(context, reservations);
      throw error;
    } finally {
      secret.fill(0);
    }
    const verifiedHash = account.state.credential.passwordHash;

    // 3. The closing unit.
    type Closed =
      | { readonly kind: 'started'; readonly expiresAt: Temporal.Instant }
      | { readonly kind: 'refused'; readonly code: 'link.rejected' | 'credentials.invalid' };
    let closed: Result<Closed, 'lost'>;
    try {
      closed = await unitOfWork.run(market, async (): Promise<Result<Closed, 'lost'>> => {
        const now = this.deps.clock.now();
        const locked = await this.deps.accounts.lockCredential(market, accountId);
        const current = locked ? await this.deps.accounts.findById(market, accountId) : null;
        if (current === null || current.state.status !== 'active') {
          await throttles.release(market, reservations);
          await this.record(context, input.client, accountId, REJECTED.code, now);
          return ok({ kind: 'refused', code: REJECTED.code });
        }
        if (current.state.credential.passwordHash !== verifiedHash) {
          await throttles.release(market, reservations);
          await this.record(context, input.client, accountId, INVALID.code, now);
          return ok({ kind: 'refused', code: INVALID.code });
        }
        const existing = await this.deps.factors.findByAccount(market, accountId);
        if (existing !== null && existing.isActive) {
          // 3.6: an enrolment link never replaces an active factor.
          await throttles.release(market, reservations);
          await this.record(context, input.client, accountId, REJECTED.code, now);
          return ok({ kind: 'refused', code: REJECTED.code });
        }
        // Item F: a stale pending factor gives way to the new one, in this unit.
        if (existing !== null) await this.deps.factors.removeOf(market, accountId);
        await this.deps.factors.add(
          market,
          SecondFactor.startEnrolment({
            id: this.deps.ids.next<'SecondFactor'>(),
            marketId: market.marketId,
            accountId,
            secretCiphertext: sealed,
            now,
          }),
        );
        if (!(await this.deps.links.consume(market, link.state.id, link.state.version, now))) {
          return err('lost');
        }
        const challenge = issueChallenge({
          id: this.deps.ids.next<'SignInChallenge'>(),
          marketId: market.marketId,
          accountId,
          purpose: 'second-factor-enrolment',
          credentialChangedAt: current.state.credential.changedAt,
          policy: challengePolicy,
          now,
        });
        await this.deps.challenges.add(market, challenge, issued.tokenHash);
        await throttles.release(market, reservations);
        await this.record(context, input.client, accountId, 'second-factor-enrolment-started', now);
        return ok({ kind: 'started', expiresAt: challenge.expiresAt });
      });
    } catch (error) {
      this.log('identity.second-factor-enrolment.closing-failed', context, {});
      await this.release(context, reservations);
      throw error;
    }
    if (!closed.ok) {
      await this.release(context, reservations);
      this.log('identity.second-factor-enrolment.link-rejected', context, { accountId });
      return err(REJECTED);
    }
    if (closed.value.kind === 'refused') {
      this.log('identity.second-factor-enrolment.refused', context, {
        accountId,
        reason: closed.value.code,
      });
      return err({ code: closed.value.code });
    }
    this.log('identity.second-factor-enrolment.started', context, { accountId });
    return ok({
      code: 'second-factor-enrolment-started',
      challengeToken: issued.token,
      expiresAt: closed.value.expiresAt,
      secret: shown.secret,
      otpauthUri: shown.uri,
    });
  }

  private async record(
    context: CallContext,
    client: SignInClient,
    accountId: Account['state']['id'],
    outcome: string,
    now: Temporal.Instant,
  ): Promise<void> {
    await this.deps.records.add(context.market, {
      id: this.deps.ids.next<'SignInRecord'>(),
      population: 'admin',
      accountId,
      outcome,
      occurredAt: now,
      address: client.address,
      sessionId: null,
      correlationId: context.correlationId,
    });
  }

  /** Gives the reservation back (nothing was guessed); false when its unit failed. */
  private release(
    context: CallContext,
    reservations: readonly ThrottleReservation[],
  ): Promise<boolean> {
    return this.quietly(context, () =>
      this.deps.unitOfWork.run(context.market, async () => {
        await this.deps.throttles.release(context.market, reservations);
        return ok(undefined);
      }),
    );
  }

  /** Runs a counter unit; false when it failed or threw (fail closed, 6.8). */
  private async quietly(
    context: CallContext,
    run: () => Promise<Result<void, never>>,
  ): Promise<boolean> {
    try {
      return (await run()).ok;
    } catch {
      this.log('identity.second-factor-enrolment.unit-unavailable', context, {});
      return false;
    }
  }

  /** Ids and codes only: never the address, the token, the secret or a password (P 12.3). */
  private log(msg: string, context: CallContext, fields: Record<string, string>): void {
    this.#logger.log({
      msg,
      ...fields,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}
