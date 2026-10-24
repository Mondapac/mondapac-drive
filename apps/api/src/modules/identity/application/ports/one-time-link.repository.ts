import type { Id, MarketContext, Temporal } from '@mondapac-drive/shared-kernel';
import type { LinkPurpose, OneTimeLink } from '../../domain/one-time-link';

/**
 * The one-time links of `identity` (identity design 3.7, 6.6; data design 3.7). Every method
 * runs in the caller's open unit of work and takes the `MarketContext` only; the Market and
 * tenant of every row come from it. A token is never passed in: only its SHA-256.
 */
export interface OneTimeLinkRepository {
  findById(market: MarketContext, id: Id<'OneTimeLink'>): Promise<OneTimeLink | null>;

  /** The one row of this account and purpose (M8), or null. */
  findFor(
    market: MarketContext,
    accountId: Id<'Account'>,
    purpose: LinkPurpose,
  ): Promise<OneTimeLink | null>;

  /** The link whose stored hash is this one, in this Market, or null (data design 3.7). */
  findByTokenHash(market: MarketContext, tokenHash: Uint8Array): Promise<OneTimeLink | null>;

  add(market: MarketContext, link: OneTimeLink): Promise<void>;

  /**
   * Stores the changes of a loaded link if its version is still the one read; otherwise throws
   * `StaleAggregateError` (platform persistence 10).
   */
  save(market: MarketContext, link: OneTimeLink): Promise<void>;

  /**
   * The single use (data design 3.7): one conditional statement that sets `consumed_at` only
   * while the link is unused, unexpired at `now` and still at `expectedVersion` (the version the
   * caller read with its token), and raises the version. True when it did; false when a
   * concurrent use, a new request (re-issue) or the expiry came first.
   */
  consume(
    market: MarketContext,
    id: Id<'OneTimeLink'>,
    expectedVersion: number,
    now: Temporal.Instant,
  ): Promise<boolean>;

  /**
   * Cancels the account's unused link of this purpose, if any: one conditional statement that
   * clears the token hash and the instants and raises the version, as a new request does, so an
   * issued link stops working at once and a mail still pending for it is skipped as superseded.
   * No event is recorded. True when a row changed (Hassan L2, slice 4: a password change cancels
   * an outstanding reset link).
   */
  cancelUnused(
    market: MarketContext,
    accountId: Id<'Account'>,
    purpose: LinkPurpose,
  ): Promise<boolean>;

  /** Deletes links consumed or expired before `before` (the hourly purge, data design 9). */
  purgeSpent(market: MarketContext, before: Temporal.Instant): Promise<number>;
}

/** Nest token of the {@link OneTimeLinkRepository}. */
export const ONE_TIME_LINK_REPOSITORY = Symbol('ONE_TIME_LINK_REPOSITORY');
