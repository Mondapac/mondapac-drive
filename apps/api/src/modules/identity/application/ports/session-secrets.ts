import type { MarketContext, Population } from '@mondapac-drive/shared-kernel';

/** A newly issued session token and the hash that is stored (identity design 6.2). */
export interface IssuedSessionToken {
  /** The secret: set in the cookie, never logged, stored or put in an error or a response body. */
  readonly token: string;
  readonly tokenHash: Uint8Array;
}

/**
 * Session tokens (identity design 6.2): 32 bytes from the system random source, base64url, with
 * a short version prefix; only the SHA-256 is stored.
 */
export interface SessionTokens {
  /**
   * A new token. A merchant API key has its own prefix (`kind: 'api-key'`), so a scanner, a log
   * filter or a person tells a long-lived integration key from a browser or app session.
   */
  issue(kind?: 'session' | 'api-key'): IssuedSessionToken;
  /** The stored hash of a presented token, or null when it does not have the token's shape. */
  hashOf(token: string): Uint8Array | null;
}

/** Nest token of the {@link SessionTokens}. */
export const SESSION_TOKENS = Symbol('SESSION_TOKENS');

/**
 * The keys of the throttle counters (identity design 6.8; data design 3.5): HMAC-SHA-256 under a
 * stack secret, so no address or email is stored, also for unknown addresses. Every key includes
 * the Market (A6). `origin` is the IPv4 address or the IPv6 /64, already cut by the caller (HF3).
 */
export interface ThrottleKeys {
  /** (Market, population, normalised email): the address counters and their `account_key`. */
  account(market: MarketContext, population: Population, emailNormalized: string): Uint8Array;
  /** (Market, population, normalised email, origin). */
  accountOrigin(
    market: MarketContext,
    population: Population,
    emailNormalized: string,
    origin: string,
  ): Uint8Array;
  /** (Market, origin). */
  origin(market: MarketContext, origin: string): Uint8Array;
}

/** Nest token of the {@link ThrottleKeys}. */
export const THROTTLE_KEYS = Symbol('THROTTLE_KEYS');
