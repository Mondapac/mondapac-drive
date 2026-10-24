import type { MarketContext, Population } from '@mondapac-drive/shared-kernel';

/** A newly minted link token and the hash that is stored (identity design 6.6). */
export interface IssuedLinkToken {
  /** The secret: only in the mail's link fragment; never stored, logged, or put in an event. */
  readonly token: string;
  readonly tokenHash: Uint8Array;
}

/**
 * Link tokens (identity design 6.6): the token shape and storage of sessions (6.2) with a prefix
 * of their own, so a session token is never taken for a link token or the other way round.
 */
export interface LinkTokens {
  issue(): IssuedLinkToken;
  /** The stored hash of a presented token, or null when it does not have the token's shape. */
  hashOf(token: string): Uint8Array | null;
}

/** Nest token of the {@link LinkTokens}. */
export const LINK_TOKENS = Symbol('LINK_TOKENS');

/**
 * The pages a mail of `identity` links to, per population, as in the Market file: the admin
 * panel's and the courier app's. A merchant is never mailed a link (its keys are issued by an
 * operator), so it has no page.
 */
export interface LinkPages {
  readonly admin: 'sign-in' | 'accept-invitation' | 'enrol-second-factor' | 'reset-password';
  readonly courier: 'sign-in' | 'accept-invitation' | 'reset-password';
  readonly merchant: never;
}

/** A page of {@link LinkPages}: of one population, or of any when none is named. */
export type LinkPage<P extends Population = Population> = LinkPages[P];

/**
 * Where a mail's link points (identity design 9, `LinkTargets(market, population, purpose)`):
 * configuration, because the panel and storefront hosts are not decided (brief s6; D2). The
 * answer is an absolute URL without a fragment; the token, when there is one, goes into the
 * fragment, never the path or the query (I15). Null when the Market configures no page for this
 * population, including a page of another population: the mail cannot be sent.
 */
export interface LinkTargets {
  target<P extends Population>(
    market: MarketContext,
    population: P,
    page: LinkPage<P>,
  ): string | null;
}

/** Nest token of the {@link LinkTargets}. */
export const LINK_TARGETS = Symbol('LINK_TARGETS');
