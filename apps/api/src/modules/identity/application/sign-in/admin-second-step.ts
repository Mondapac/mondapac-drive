import type { CallContext, IdGenerator, Temporal } from '@mondapac-drive/shared-kernel';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { Account } from '../../domain/account';
import { OneTimeLink } from '../../domain/one-time-link';
import { issueChallenge, type ChallengePolicy } from '../../domain/sign-in-challenge';
import { reservationVerdict, type ThrottleRule } from '../../domain/throttle';
import type { IssuedLinkToken } from '../ports/link-secrets';
import type { OneTimeLinkRepository } from '../ports/one-time-link.repository';
import type { OpaqueTokens } from '../ports/second-factor-tokens';
import type { SecondFactorRepository } from '../ports/second-factor.repository';
import type { ThrottleKeys } from '../ports/session-secrets';
import type { SignInChallengeRepository } from '../ports/sign-in-challenge.repository';
import type { ThrottleCounter, ThrottleRepository } from '../ports/throttle.repository';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import { lockedFor } from '../second-factor/code-check';

/** What the admin sign-in needs on top of the password sequence (identity design 6.3 step 5). */
export interface AdminSecondStepDependencies {
  readonly factors: SecondFactorRepository;
  readonly challenges: SignInChallengeRepository;
  readonly links: OneTimeLinkRepository;
  readonly throttles: ThrottleRepository;
  readonly keys: ThrottleKeys;
  readonly outbox: OutboxWriter;
  readonly policy: IdentityMarketPolicy;
  readonly ids: IdGenerator;
  readonly challengeTokens: OpaqueTokens;
}

/** The policy values the step needs; read before any unit, so a gap fails closed early. */
export interface AdminSecondStepPolicy {
  readonly challenge: ChallengePolicy;
  readonly secondFactorThrottle: ThrottleRule;
}

/** Where an admin's correct password leads (6.3 step 5); never to a session. */
export type AdminSecondStepOutcome =
  | {
      readonly code: 'second-factor-required';
      /** The challenge's token: posted back with the code; never a credential (I1). */
      readonly challengeToken: string;
      readonly expiresAt: Temporal.Instant;
    }
  | { readonly code: 'second-factor-enrolment-required' }
  | { readonly code: 'second-factor.locked'; readonly retryAfterSeconds: number };

/**
 * Step 5 of the sign-in sequence for the admin population (identity design 6.3, 3.6, 7.2; AC 10,
 * AC 22; HF2, HF6), run inside the closing unit after a correct password and before the state of
 * the account is told (6.3 steps 4 to 6):
 *
 * - an active factor that is not locked: a `SignInChallenge` (purpose `second-factor`) bound to
 *   the credential's `changedAt` (HF11) is stored with the hash of a new token, and the answer
 *   asks for a code (`second-factor-required`);
 * - an active factor locked by HF2: `second-factor.locked` with the rest of the block, read from
 *   the factor's lock instant (the counter itself is reserved again at the code step);
 * - no active factor (only after a reset, or a stale pending enrolment): an `enrol-second-factor`
 *   link is requested for the account (the earlier one stops working), when the `mail.account`
 *   counter of the address allows a mail (6.8); the answer is the same either way
 *   (`second-factor-enrolment-required`).
 *
 * A password alone never opens an admin session (AC 10).
 */
export class AdminSecondStep {
  constructor(private readonly deps: AdminSecondStepDependencies) {}

  /** A challenge token, minted before the closing unit like a session token (6.3). */
  issueToken(): IssuedLinkToken {
    return this.deps.challengeTokens.issue();
  }

  async decide(
    context: CallContext,
    account: Account,
    policy: AdminSecondStepPolicy,
    challengeToken: IssuedLinkToken,
    now: Temporal.Instant,
  ): Promise<AdminSecondStepOutcome> {
    const { market } = context;
    const accountId = account.state.id;
    const factor = await this.deps.factors.findByAccount(market, accountId);
    if (factor !== null && factor.isActive) {
      const wait = lockedFor(factor.state.lockedAt, policy.secondFactorThrottle, now);
      if (wait !== null) return { code: 'second-factor.locked', retryAfterSeconds: wait };
      const challenge = issueChallenge({
        id: this.deps.ids.next<'SignInChallenge'>(),
        marketId: market.marketId,
        accountId,
        purpose: 'second-factor',
        credentialChangedAt: account.state.credential.changedAt,
        policy: policy.challenge,
        now,
      });
      await this.deps.challenges.add(market, challenge, challengeToken.tokenHash);
      return {
        code: 'second-factor-required',
        challengeToken: challengeToken.token,
        expiresAt: challenge.expiresAt,
      };
    }
    if (await this.mailAllowed(context, account, now)) {
      const found = await this.deps.links.findFor(market, accountId, 'enrol-second-factor');
      let link: OneTimeLink;
      if (found === null) {
        link = OneTimeLink.request({
          id: this.deps.ids.next<'OneTimeLink'>(),
          marketId: market.marketId,
          accountId,
          purpose: 'enrol-second-factor',
          now,
          notify: true,
        });
        await this.deps.links.add(market, link);
      } else {
        link = found;
        link.requestAgain(now, true);
        await this.deps.links.save(market, link);
      }
      await this.deps.outbox.append(context, link.pendingEvents);
    }
    return { code: 'second-factor-enrolment-required' };
  }

  /** `mail.account` of the address (6.8): the enrolment link is a mail like a reset's. */
  private async mailAllowed(
    context: CallContext,
    account: Account,
    now: Temporal.Instant,
  ): Promise<boolean> {
    const { market } = context;
    const rule = this.deps.policy.mailThrottles(market).account;
    const accountKey = this.deps.keys.account(
      market,
      account.state.population,
      account.state.email.normalized,
    );
    const counter: ThrottleCounter = {
      kind: 'mail.account',
      keyHash: accountKey,
      accountKey,
      rule,
    };
    const [reservation] = await this.deps.throttles.reserve(market, [counter], now);
    return reservationVerdict([{ reservation: reservation!, rule }], now).allowed;
  }
}
