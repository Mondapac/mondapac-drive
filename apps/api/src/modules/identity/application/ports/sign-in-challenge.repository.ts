import type { Id, MarketContext, Temporal } from '@mondapac-drive/shared-kernel';
import type { SignInChallenge } from '../../domain/sign-in-challenge';

/**
 * The sign-in challenges of `identity` (identity design 2.1, 6.3; data design 3.10). Every
 * method runs in the caller's open unit and takes the `MarketContext` only. A challenge changes
 * only by single guarded statements (M1); a token is never passed in, only its SHA-256.
 */
export interface SignInChallengeRepository {
  /** Stores a new challenge with the hash of its token. */
  add(market: MarketContext, challenge: SignInChallenge, tokenHash: Uint8Array): Promise<void>;

  /** The challenge whose stored hash is this one, in this Market, or null. */
  findByTokenHash(market: MarketContext, tokenHash: Uint8Array): Promise<SignInChallenge | null>;

  /**
   * Reserves one attempt before the code is checked (HF1; data design 3.10): one guarded
   * statement that adds one only while the challenge is unconsumed, unexpired at `now` and below
   * `maxAttempts`. True when it did; false means the challenge has ended, and N concurrent
   * attempts never get more than `maxAttempts` checks between them.
   */
  reserveAttempt(
    market: MarketContext,
    id: Id<'SignInChallenge'>,
    maxAttempts: number,
    now: Temporal.Instant,
  ): Promise<boolean>;

  /** The single use: sets `consumed_at` only while unconsumed and unexpired. True when it did. */
  consume(
    market: MarketContext,
    id: Id<'SignInChallenge'>,
    now: Temporal.Instant,
  ): Promise<boolean>;

  /**
   * Voids every challenge of the account (HF11; data design 3.10): deletes them in the unit of
   * the change that voids them (a password reset or change, a factor change, a disable, a
   * suspension), so none can complete afterwards. Answers how many were deleted.
   */
  voidAllOf(market: MarketContext, accountId: Id<'Account'>): Promise<number>;

  /** Deletes challenges that expired before `before` (the hourly purge, data design 9). */
  purgeExpired(market: MarketContext, before: Temporal.Instant): Promise<number>;
}

/** Nest token of the {@link SignInChallengeRepository}. */
export const SIGN_IN_CHALLENGE_REPOSITORY = Symbol('SIGN_IN_CHALLENGE_REPOSITORY');
