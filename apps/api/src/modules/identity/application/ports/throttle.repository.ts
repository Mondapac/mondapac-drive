import type { MarketContext, Temporal } from '@mondapac-drive/shared-kernel';
import type { ThrottleKind, ThrottleReservation, ThrottleRule } from '../../domain/throttle';

/** One counter to reserve: its kind, its keyed hash, the address key and the rule's window. */
export interface ThrottleCounter {
  readonly kind: ThrottleKind;
  readonly keyHash: Uint8Array;
  /** The keyed hash of (Market, population, email) for an address counter; null for an origin. */
  readonly accountKey: Uint8Array | null;
  readonly rule: ThrottleRule;
}

/** A block to set: the counter as reserved, and the end of the block. */
export interface ThrottleBlock {
  readonly reservation: ThrottleReservation;
  readonly until: Temporal.Instant;
}

/**
 * The throttle counters of `identity` (identity design 6.8; data design 3.5): fixed windows with
 * a block instant, keyed by HMAC. Every method runs in the caller's open read-write unit.
 */
export interface ThrottleRepository {
  /**
   * Counts one attempt on every counter, in the fixed order (kind, then key), and answers the
   * counters as they now stand, in the order given (HF1). An ended window restarts first.
   */
  reserve(
    market: MarketContext,
    counters: readonly ThrottleCounter[],
    now: Temporal.Instant,
  ): Promise<ThrottleReservation[]>;

  /** Gives back a reservation (a correct password): one attempt less, in the same window only. */
  release(market: MarketContext, reservations: readonly ThrottleReservation[]): Promise<void>;

  /** Blocks each counter until its `until`, in the reserved window only, in the fixed order. */
  block(market: MarketContext, blocks: readonly ThrottleBlock[]): Promise<void>;

  /**
   * Deletes the sign-in counters of one address, `sign-in.account` and `sign-in.account-origin`
   * (identity design 3.7: a reset lifts a sign-in block; AC 13), by its `account_key` (data
   * design 3.5). `mail.account` stays, so a reset cannot refill the address's mail budget, and so
   * does `second-factor.account`: nothing lifts that block early (identity design 6.8; Ali
   * 2026-10-08).
   * Origin counters carry no address and stay. Answers how many rows went.
   */
  clearAccount(market: MarketContext, accountKey: Uint8Array): Promise<number>;

  /**
   * Deletes counters whose window started before `windowStartedBefore` and that are not blocked
   * at `now`; answers how many.
   */
  purge(
    market: MarketContext,
    windowStartedBefore: Temporal.Instant,
    now: Temporal.Instant,
  ): Promise<number>;
}

/** Nest token of the {@link ThrottleRepository}. */
export const THROTTLE_REPOSITORY = Symbol('THROTTLE_REPOSITORY');
