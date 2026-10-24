import type { Id, MarketContext, MarketId } from '@mondapac-drive/shared-kernel';
import type { CourierState } from '../domain/courier';
import type { CourierStatus } from '../domain/courier-status';
import type { MarketFleetRules } from '../domain/fleet-rules';

/**
 * The couriers of one Market. Every method runs inside the caller's unit of work
 * (`platform/unit-of-work`): reads in a read-only or read-write unit, writes in a read-write one.
 */
export interface CourierRepository {
  findById(market: MarketContext, id: Id<'Courier'>): Promise<CourierState | undefined>;
  findByActorId(market: MarketContext, actorId: string): Promise<CourierState | undefined>;
  /** The couriers of these accounts in the Market, whatever their standing. */
  findByActorIds(market: MarketContext, actorIds: readonly string[]): Promise<CourierState[]>;
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
  /**
   * A page of the Market's couriers in id order (UUIDv7, so oldest first), after `after`,
   * optionally of one standing.
   */
  list(
    market: MarketContext,
    query: {
      readonly status?: CourierStatus;
      readonly after?: Id<'Courier'>;
      readonly limit: number;
    },
  ): Promise<CourierState[]>;
  /** Which of these file keys a document row of the Market names. */
  namedFileKeys(market: MarketContext, fileKeys: readonly string[]): Promise<Set<string>>;
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
  /** What the courier app shows in the Market. */
  courierAppSettings(marketId: MarketId): CourierAppSettings;
}

/** The Market settings the courier app runs on (the app's `CourierSettings`). */
export interface CourierAppSettings {
  readonly marketId: MarketId;
  readonly locale: string;
  readonly currency: string;
  readonly distanceUnit: 'km' | 'mi';
  /** E.164. */
  readonly supportPhone: string;
  /** How long a courier has to accept an offer (dispatch's offer timeout). */
  readonly offerAcceptSeconds: number;
  readonly coldChain: {
    readonly chilled: { readonly maxCelsius: number };
    readonly frozen: { readonly maxCelsius: number };
  };
}
export const FLEET_RULES = Symbol('FleetRulesProvider');
