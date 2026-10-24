import type { MarketContext, Population } from '@mondapac-drive/shared-kernel';
import type { InvitationKind } from '../../domain/invitation';
import type { LinkPurpose } from '../../domain/one-time-link';
import type { ChallengePolicy } from '../../domain/sign-in-challenge';
import type { PasswordRules } from '../../domain/password-policy';
import type { SessionLifetime } from '../../domain/session';
import type { ThrottleRule } from '../../domain/throttle';

/** The sign-in counters of identity design 6.8 for one Market. */
export interface SignInThrottleRules {
  readonly accountOrigin: ThrottleRule;
  readonly account: ThrottleRule;
  readonly origin: ThrottleRule;
}

/** The mail counters of identity design 6.8 for one Market. */
export interface MailThrottleRules {
  readonly account: ThrottleRule;
  readonly origin: ThrottleRule;
}

/**
 * The identity policy of a Market (identity design 8.5): one port through which `identity`
 * reads its policy values. The Phase 2 adapter reads Market configuration as code (the
 * `identity` section); the later ADR "Market settings editable by an admin" replaces the
 * adapter, not this port. A read is synchronous and never defaults a Market.
 *
 * Drive reads the password rules, the session and API-key lifetimes, the throttles, the
 * retention of sign-in records, the link and invitation lifetimes and the mail sender.
 */
export interface IdentityMarketPolicy {
  passwordRules(market: MarketContext): PasswordRules;
  /**
   * The lifetimes of a population's sessions (identity design 6.1), or null when the Market
   * configures none for it: such a population cannot open a session. A merchant has none: its
   * API keys use {@link apiKeyLifetime}.
   */
  sessionLifetime(market: MarketContext, population: Population): SessionLifetime | null;
  /**
   * A merchant API key's lifetime (idle equal to absolute: a key is not timed out by quiet
   * periods), or null when the Market issues no key.
   */
  apiKeyLifetime(market: MarketContext): SessionLifetime | null;
  signInThrottles(market: MarketContext): SignInThrottleRules;
  mailThrottles(market: MarketContext): MailThrottleRules;
  /** Sign-in records are deleted this many days after the attempt (H3). */
  signInRecordRetentionDays(market: MarketContext): number;
  /**
   * A link's lifetime from its issue (identity design 6.6; HF15: verification 24 hours), or
   * null when the Market configures none for the purpose: such a link is never issued.
   */
  linkLifetimeMinutes(market: MarketContext, purpose: LinkPurpose): number | null;
  /** The sender of the Market's mail (identity design 9). */
  mailSender(market: MarketContext): MailSender;

  // Until a Market configures these, each read answers null and the flow that needs it fails
  // closed (`access.unavailable`, or the operator routine refuses). The admin session lifetime is
  // `sessionLifetime(market, 'admin')`, the enrolment link's `linkLifetimeMinutes(market,
  // 'enrol-second-factor')`, and the admin pages `LinkTargets.target(market, 'admin', page)`.

  /**
   * An invitation's lifetime from its dispatch, by kind (identity design 3.4, 6.6; HF15: admin
   * at most 72 hours, courier at most 7 days); also the cut-off after which a never-dispatched pending
   * invitation is replaced or purged (item G). Null: not configured for this kind.
   */
  invitationLifetimeMinutes(market: MarketContext, kind: InvitationKind): number | null;

  /** The challenge policy (identity design 2.1, 6.8: 5 attempts, 5 minutes), or null. */
  challengePolicy(market: MarketContext): ChallengePolicy | null;

  /**
   * The `second-factor.account` counter (identity design 6.8, HF2: 10 failed codes or recovery
   * codes in 24 hours, then the factor step is refused for 24 hours), or null. Nothing lifts its
   * block early (Ali 2026-10-08, Hassan I-4).
   */
  secondFactorThrottle(market: MarketContext): ThrottleRule | null;

  /**
   * The `sign-out-others.account` counter (profile package 4, Hassan's follow-up: AU 5 in 60
   * minutes, no block), or null, so "sign out of all other devices" fails closed.
   */
  signOutOthersThrottle(market: MarketContext): ThrottleRule | null;

  /**
   * The most custom roles a Market may hold (identity design 2.3; custom roles are platform
   * roles only in Drive), or null when the Market configures none, so the role editor's create
   * fails closed (`access.unavailable`).
   */
  customRoleLimit(market: MarketContext, scope: 'platform'): number | null;
}

/** The `From` of a Market's mail. */
export interface MailSender {
  readonly address: string;
  readonly name: string;
}

/** Nest token of the {@link IdentityMarketPolicy}. */
export const IDENTITY_MARKET_POLICY = Symbol('IDENTITY_MARKET_POLICY');
