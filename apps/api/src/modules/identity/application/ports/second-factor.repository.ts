import type { Id, MarketContext, Temporal } from '@mondapac-drive/shared-kernel';
import type { SecondFactor } from '../../domain/second-factor';

/**
 * The second factors of `identity` (identity design 3.6, 7; data design 3.10). Every method runs
 * in the caller's open unit of work and takes the `MarketContext` only; the Market and tenant of
 * every row come from it. Only ciphertext and keyed hashes pass through here, never a secret or
 * a recovery code in clear.
 */
export interface SecondFactorRepository {
  /** The factor of this account, with its recovery codes, or null (`none`). */
  findByAccount(market: MarketContext, accountId: Id<'Account'>): Promise<SecondFactor | null>;

  /**
   * Stores a new factor and its recovery codes. An account that already has one (a concurrent
   * enrolment) throws `StaleAggregateError`: one factor per account (data design 3.10).
   */
  add(market: MarketContext, factor: SecondFactor): Promise<void>;

  /**
   * Stores the changes of a loaded factor if its version is still the one read, replacing its
   * recovery codes when they changed (activation, regeneration); otherwise throws
   * `StaleAggregateError` (platform persistence 10).
   */
  save(market: MarketContext, factor: SecondFactor): Promise<void>;

  /**
   * Accepts a time step of the active factor once (identity design 7.1; data design 3.10): one
   * guarded statement that sets `last_accepted_step` only while it is null or smaller, and
   * raises the version (C5). True when it did; false when the step was already accepted (a
   * replayed or concurrent code), the factor is not active, or it is gone.
   */
  acceptStep(market: MarketContext, id: Id<'SecondFactor'>, step: number): Promise<boolean>;

  /**
   * Spends the unused recovery code of this factor with this keyed hash (identity design 7.3):
   * one guarded statement on `used_at IS NULL`, then the factor's version raised (P 10). True
   * when a code was spent; false when no unused code of an active factor has the hash.
   */
  useRecoveryCode(
    market: MarketContext,
    id: Id<'SecondFactor'>,
    codeHash: Uint8Array,
    now: Temporal.Instant,
  ): Promise<boolean>;

  /**
   * Removes the account's factor and its codes (a reset: the factor returns to `none`, D 3.6).
   * True when there was one.
   */
  removeOf(market: MarketContext, accountId: Id<'Account'>): Promise<boolean>;

  /**
   * Which of these accounts have an active factor (the reviewer rule, identity design 8.7):
   * one read by the `(market_id, account_id)` key, ids only.
   */
  activeAmong(
    market: MarketContext,
    accountIds: readonly Id<'Account'>[],
  ): Promise<ReadonlySet<Id<'Account'>>>;

  /**
   * Which of these accounts have a factor in any state: the condition under which
   * `findByAccount` answers one (the admin team list's reset hint, slice 8c). Ids only, never a
   * secret or a recovery code.
   */
  presentAmong(
    market: MarketContext,
    accountIds: readonly Id<'Account'>[],
  ): Promise<ReadonlySet<Id<'Account'>>>;
}

/** Nest token of the {@link SecondFactorRepository}. */
export const SECOND_FACTOR_REPOSITORY = Symbol('SECOND_FACTOR_REPOSITORY');
