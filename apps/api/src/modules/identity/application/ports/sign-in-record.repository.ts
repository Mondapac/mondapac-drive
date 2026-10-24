import type { Id, MarketContext, Population, Temporal } from '@mondapac-drive/shared-kernel';

/**
 * One sign-in attempt (identity design 10.2; data design 3.6): never the typed email. `address`
 * is the client's full address, personal data, kept for the Market's retention only.
 */
export interface SignInRecord {
  readonly id: Id<'SignInRecord'>;
  readonly population: Population;
  readonly accountId: Id<'Account'> | null;
  /** The outcome code of identity design 6.3. */
  readonly outcome: string;
  readonly occurredAt: Temporal.Instant;
  readonly address: string;
  readonly sessionId: Id<'Session'> | null;
  readonly correlationId: string;
}

/**
 * The sign-in records of `identity` (append-only for the application by privilege). Every
 * method runs in the caller's open read-write unit.
 */
export interface SignInRecordRepository {
  add(market: MarketContext, record: SignInRecord): Promise<void>;

  /**
   * The instant of the account's latest successful sign-in other than the one that opened
   * `exceptSession` (the caller's own), or null when the records hold none (they are kept for
   * the Market's retention only). Read-only.
   */
  latestSuccessBefore(
    market: MarketContext,
    accountId: Id<'Account'>,
    exceptSession: Id<'Session'>,
  ): Promise<Temporal.Instant | null>;

  /** The instant of the oldest record, or null when there is none. */
  oldest(market: MarketContext): Promise<Temporal.Instant | null>;

  /** Deletes the records with `from <= occurredAt < to`; answers how many. */
  deleteBetween(
    market: MarketContext,
    from: Temporal.Instant,
    to: Temporal.Instant,
  ): Promise<number>;
}

/** Nest token of the {@link SignInRecordRepository}. */
export const SIGN_IN_RECORD_REPOSITORY = Symbol('SIGN_IN_RECORD_REPOSITORY');
