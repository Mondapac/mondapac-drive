import type { Id, MarketContext, Temporal } from '@mondapac-drive/shared-kernel';
import type { Session, SessionRevokedReason } from '../../domain/session';
import type { MerchantStateCode } from '../../domain/merchant';

/** What the `Authenticator` reads per request, in one call (identity design 6.2). */
export interface SessionForAuthentication {
  readonly session: Session;
  readonly accountStatus: 'active' | 'disabled';
  /**
   * For a merchant session (an API key), read in the same call: the merchant of the account's
   * active membership (null when it has none), and the state of the session's merchant. Both
   * null for every other population.
   */
  readonly activeMembershipMerchantId: Id<'Merchant'> | null;
  readonly merchantState: MerchantStateCode | null;
}

/**
 * The sessions of `identity` (identity design 3.5, 6.2; data design 3.4). Every method runs in
 * the caller's open unit (read-only where it only reads) and takes the `MarketContext` only;
 * the Market and tenant of every row come from it. The token itself never reaches this port:
 * only its SHA-256.
 */
export interface SessionRepository {
  /** Stores a new session with the hash of its token. */
  add(market: MarketContext, session: Session, tokenHash: Uint8Array): Promise<void>;

  /** The session with this token hash and the status of its account, or null. */
  findForAuthentication(
    market: MarketContext,
    tokenHash: Uint8Array,
  ): Promise<SessionForAuthentication | null>;

  /** The session with this id, or null. */
  findById(market: MarketContext, id: Id<'Session'>): Promise<Session | null>;

  /**
   * The account's sessions that are not revoked and not past their absolute expiry at `now`,
   * most recently used first, at most `limit` (profile package 4). The idle timeout is the
   * caller's to apply (`sessionIsLive`).
   */
  listUnrevokedOf(
    market: MarketContext,
    accountId: Id<'Account'>,
    now: Temporal.Instant,
    limit: number,
  ): Promise<readonly Session[]>;

  /**
   * Writes `lastSeenAt = now` when it is older than `lastSeenBefore` and the session is not
   * revoked; a no-op otherwise (at most once a minute, identity design 6.1).
   */
  touch(
    market: MarketContext,
    id: Id<'Session'>,
    now: Temporal.Instant,
    lastSeenBefore: Temporal.Instant,
  ): Promise<void>;

  /**
   * Revokes this account's session if it is not revoked yet (a set-based update that never
   * loses against `touch`). Answers whether a row changed.
   */
  revoke(
    market: MarketContext,
    id: Id<'Session'>,
    accountId: Id<'Account'>,
    reason: SessionRevokedReason,
    now: Temporal.Instant,
  ): Promise<boolean>;

  /**
   * Revokes every session of the account that is not revoked yet, except `exceptId` when given
   * (identity design 3.5: a reset ends all of them; a change all but the current one, which is
   * rotated). One set-based update; answers how many rows changed. The caller holds the
   * account's credential lock (`AccountRepository.lockCredential`), so a session a racing
   * sign-in opened with the old password is either already committed, and revoked here, or
   * never opened.
   */
  revokeAllOf(
    market: MarketContext,
    accountId: Id<'Account'>,
    reason: SessionRevokedReason,
    now: Temporal.Instant,
    exceptId: Id<'Session'> | null,
  ): Promise<number>;

  /**
   * The merchant's API keys that are not revoked and not past their expiry at `now`, newest
   * first (the operator's key list). Never a token or its hash.
   */
  listApiKeysOf(
    market: MarketContext,
    merchantId: Id<'Merchant'>,
    now: Temporal.Instant,
  ): Promise<readonly Session[]>;

  /**
   * Revokes every API key of the merchant that is not revoked yet (the merchant suspended): one
   * set-based update on the sessions' merchant copy. The caller updated the merchant row in the
   * same unit, and issuing a key takes the merchant's version too, so a key issued in a race is
   * either committed, and revoked here, or never stored. Answers how many rows changed.
   */
  revokeAllOfMerchant(
    market: MarketContext,
    merchantId: Id<'Merchant'>,
    reason: SessionRevokedReason,
    now: Temporal.Instant,
  ): Promise<number>;

  /**
   * Gives the account's live session a new token (identity design 6.2: the current session at a
   * password change): replaces its stored hash in place, only while it is not revoked. Answers
   * whether it did; false when the session was revoked or is gone.
   */
  rotate(
    market: MarketContext,
    id: Id<'Session'>,
    accountId: Id<'Account'>,
    tokenHash: Uint8Array,
  ): Promise<boolean>;

  /** Deletes sessions whose absolute expiry is before `expiredBefore`; answers how many. */
  purgeExpired(market: MarketContext, expiredBefore: Temporal.Instant): Promise<number>;
}

/** Nest token of the {@link SessionRepository}. */
export const SESSION_REPOSITORY = Symbol('SESSION_REPOSITORY');
