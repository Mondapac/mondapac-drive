import type { Id, MarketContext } from '@mondapac-drive/shared-kernel';
import type { Merchant, MerchantMembership } from '../../domain/merchant';

/**
 * The merchants of `identity` and their memberships. Every method runs in the caller's open unit
 * and takes the `MarketContext` only; a merchant of another Market is never read.
 */
export interface MerchantRepository {
  findById(market: MarketContext, id: Id<'Merchant'>): Promise<Merchant | null>;

  /** The merchants of the Market by name, then id (the operator's list). */
  list(market: MarketContext): Promise<Merchant[]>;

  add(market: MarketContext, merchant: Merchant): Promise<void>;

  /** Stores a changed merchant at the version read; otherwise throws `StaleAggregateError`. */
  save(market: MarketContext, merchant: Merchant): Promise<void>;
}

export interface MerchantMembershipRepository {
  /** The active membership of this account, or null. */
  findActiveByAccount(
    market: MarketContext,
    accountId: Id<'Account'>,
  ): Promise<MerchantMembership | null>;

  /** The accounts with an active membership of the merchant (its integration account). */
  activeMembersOf(market: MarketContext, merchantId: Id<'Merchant'>): Promise<Id<'Account'>[]>;

  add(market: MarketContext, membership: MerchantMembership): Promise<void>;
}

/** Nest tokens. */
export const MERCHANT_REPOSITORY = Symbol('MERCHANT_REPOSITORY');
export const MERCHANT_MEMBERSHIP_REPOSITORY = Symbol('MERCHANT_MEMBERSHIP_REPOSITORY');
