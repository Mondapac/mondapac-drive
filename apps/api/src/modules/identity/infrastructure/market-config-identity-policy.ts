import type { MarketContext, Population } from '@mondapac-drive/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type {
  IdentityMarketPolicy,
  MailSender,
  MailThrottleRules,
  SignInThrottleRules,
} from '../application/ports/identity-market-policy';
import type { LinkPage, LinkTargets } from '../application/ports/link-secrets';
import type { InvitationKind } from '../domain/invitation';
import type { LinkPurpose } from '../domain/one-time-link';
import type { PasswordRules } from '../domain/password-policy';
import type { SessionLifetime } from '../domain/session';
import type { ChallengePolicy } from '../domain/sign-in-challenge';
import type { ThrottleRule } from '../domain/throttle';

/**
 * The Phase 2 adapter of {@link IdentityMarketPolicy} (identity design 8.5): the `identity`
 * section of the Market's configuration, validated and frozen at boot. A Market this Region
 * Stack does not host throws (`MarketNotHostedError`); it never falls back to another Market.
 */
export class MarketConfigIdentityPolicy implements IdentityMarketPolicy, LinkTargets {
  constructor(private readonly markets: MarketRegistry) {}

  passwordRules(market: MarketContext): PasswordRules {
    return this.markets.get(market.marketId).identity.password;
  }

  sessionLifetime(market: MarketContext, population: Population): SessionLifetime | null {
    const sessions: Partial<
      Record<Population, { idleTimeoutMinutes: number; absoluteLifetimeMinutes: number }>
    > = this.markets.get(market.marketId).identity.sessions;
    const lifetime = Object.hasOwn(sessions, population) ? sessions[population] : undefined;
    if (lifetime === undefined) return null;
    return {
      idleTimeoutSeconds: lifetime.idleTimeoutMinutes * 60,
      absoluteLifetimeSeconds: lifetime.absoluteLifetimeMinutes * 60,
    };
  }

  /** `identity.apiKeys.lifetimeDays`; idle equals absolute. Null when the Market issues none. */
  apiKeyLifetime(market: MarketContext): SessionLifetime | null {
    const days = this.markets.get(market.marketId).identity.apiKeys?.lifetimeDays;
    if (days === undefined) return null;
    const seconds = days * 24 * 60 * 60;
    return { idleTimeoutSeconds: seconds, absoluteLifetimeSeconds: seconds };
  }

  signInThrottles(market: MarketContext): SignInThrottleRules {
    return this.markets.get(market.marketId).identity.signInThrottles;
  }

  mailThrottles(market: MarketContext): MailThrottleRules {
    return this.markets.get(market.marketId).identity.mailThrottles;
  }

  signInRecordRetentionDays(market: MarketContext): number {
    return this.markets.get(market.marketId).identity.signInRecordRetentionDays;
  }

  linkLifetimeMinutes(market: MarketContext, purpose: LinkPurpose): number | null {
    const lifetimes: Partial<Record<LinkPurpose, number>> = this.markets.get(market.marketId)
      .identity.links.lifetimeMinutes;
    return (Object.hasOwn(lifetimes, purpose) ? lifetimes[purpose] : undefined) ?? null;
  }

  mailSender(market: MarketContext): MailSender {
    const { fromAddress, fromName } = this.markets.get(market.marketId).identity.mail;
    return { address: fromAddress, name: fromName };
  }

  /**
   * Slice 7b (identity design 3.4, 6.6; HF15): the kind's lifetime, bounded by the Market-config
   * validator; null when the Market issues no invitation of that kind.
   */
  invitationLifetimeMinutes(market: MarketContext, kind: InvitationKind): number | null {
    const lifetimes: Partial<Record<InvitationKind, number>> =
      this.markets.get(market.marketId).identity.invitations?.lifetimeMinutes ?? {};
    return (Object.hasOwn(lifetimes, kind) ? lifetimes[kind] : undefined) ?? null;
  }

  /** The code step's challenge (6.8): at most 5 checks and 5 minutes; null without admin sign-in. */
  challengePolicy(market: MarketContext): ChallengePolicy | null {
    return this.markets.get(market.marketId).identity.challenges ?? null;
  }

  /** `second-factor.account` (6.8, HF2); null without admin sign-in, so its flows fail closed. */
  secondFactorThrottle(market: MarketContext): ThrottleRule | null {
    return this.markets.get(market.marketId).identity.secondFactorThrottles?.account ?? null;
  }

  /** `sign-out-others.account` (profile package 4); null when not configured, so it fails closed. */
  signOutOthersThrottle(market: MarketContext): ThrottleRule | null {
    return this.markets.get(market.marketId).identity.signOutOthersThrottle ?? null;
  }

  /**
   * `identity.customRoleLimits.platform` (identity design 2.3); null when the Market configures
   * none, so create fails closed.
   */
  customRoleLimit(market: MarketContext, scope: 'platform'): number | null {
    return this.markets.get(market.marketId).identity.customRoleLimits?.[scope] ?? null;
  }

  /** `LinkTargets` (identity design 9): the page per population and page, or null. */
  target<P extends Population>(
    market: MarketContext,
    population: P,
    page: LinkPage<P>,
  ): string | null {
    // Each population has its own pages in the Market file (the admin panel's differ).
    const targets: Partial<Record<Population, Partial<Record<string, string>>>> = this.markets.get(
      market.marketId,
    ).identity.links.targets;
    const pages = Object.hasOwn(targets, population) ? targets[population] : undefined;
    if (pages === undefined) return null;
    return (Object.hasOwn(pages, page) ? pages[page] : undefined) ?? null;
  }
}
