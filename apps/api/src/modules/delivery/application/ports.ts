import type { GeoPoint, Id, MarketContext, MarketId } from '@mondapac-drive/shared-kernel';
import type { DeliveryState } from '../domain/delivery';
import type { MarketDeliverySettings } from '../domain/market-settings';
import type { ServiceArea } from '../domain/service-area';

/**
 * The deliveries of one Market. Every method runs inside the caller's unit of work
 * (`platform/unit-of-work`): reads in a read-only or read-write unit, writes in a read-write one.
 */
export interface DeliveryRepository {
  findById(market: MarketContext, id: Id<'Delivery'>): Promise<DeliveryState | undefined>;
  findByExternalReference(
    market: MarketContext,
    merchantId: string,
    externalReference: string,
  ): Promise<DeliveryState | undefined>;
  /**
   * Inserts a new delivery (version 1) and its history. Answers false, and writes nothing, when
   * the merchant already booked this external reference.
   */
  insert(market: MarketContext, delivery: DeliveryState): Promise<boolean>;
  /**
   * Saves `delivery` (version n + 1) over version n and appends its new history entries.
   * Throws `StaleAggregateError` when the stored version is no longer n.
   */
  update(market: MarketContext, delivery: DeliveryState): Promise<void>;
}
export const DELIVERY_REPOSITORY = Symbol('DeliveryRepository');

/** Road distance between two points, in metres. */
export interface DistanceProvider {
  roadDistanceMetres(from: GeoPoint, to: GeoPoint): Promise<number>;
}
export const DISTANCE_PROVIDER = Symbol('DistanceProvider');

/** The delivery settings and service areas of the Markets this deployment hosts. */
export interface MarketSettingsProvider {
  /** The settings of a hosted Market; the request's Market is always hosted. */
  get(marketId: MarketId): MarketDeliverySettings;
  /** The service area a postcode is in, or undefined outside every area. */
  areaFor(marketId: MarketId, postcode: string): ServiceArea | undefined;
}
export const MARKET_SETTINGS = Symbol('MarketSettingsProvider');
