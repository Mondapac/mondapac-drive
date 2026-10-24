import type { Id, MarketContext, MarketId } from '@mondapac-drive/shared-kernel';
import type { CourierState } from '../domain/courier';
import type { MarketFleetRules } from '../domain/fleet-rules';

/**
 * The couriers of one Market. Every method runs inside the caller's unit of work
 * (`platform/unit-of-work`): reads in a read-only or read-write unit, writes in a read-write one.
 */
export interface CourierRepository {
  findById(market: MarketContext, id: Id<'Courier'>): Promise<CourierState | undefined>;
  findByActorId(market: MarketContext, actorId: string): Promise<CourierState | undefined>;
  /**
   * Inserts a newly registered courier (version 1). Answers false, and writes nothing, when the
   * account already has a courier profile in this Market.
   */
  insert(market: MarketContext, courier: CourierState): Promise<boolean>;
  /**
   * Saves `courier` (version n + 1) over version n, with its new and changed vehicles and
   * documents. Throws `StaleAggregateError` when the stored version is no longer n.
   */
  update(market: MarketContext, courier: CourierState): Promise<void>;
  /** The active couriers who are online in a service area, with their vehicles and documents. */
  findOnlineInArea(market: MarketContext, serviceAreaCode: string): Promise<CourierState[]>;
}
export const COURIER_REPOSITORY = Symbol('CourierRepository');

/** The fleet rules and service areas of the Markets this deployment hosts. */
export interface FleetRulesProvider {
  /** The rules of a hosted Market; the request's Market is always hosted. */
  get(marketId: MarketId): MarketFleetRules;
  /** Whether the Market has a service area with this code. */
  hasServiceArea(marketId: MarketId, code: string): boolean;
}
export const FLEET_RULES = Symbol('FleetRulesProvider');
