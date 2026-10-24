import type { GeoPoint, Id, MarketContext, MarketId } from '@mondapac-drive/shared-kernel';
import type { DeliveryState } from '../domain/delivery';
import type { MarketDeliverySettings } from '../domain/market-settings';
import type { ServiceArea } from '../domain/service-area';
import type { VehicleType } from '../domain/vehicle';

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

/** Road distance between two points for a vehicle, in metres. Always answers (an estimate at worst). */
export interface DistanceProvider {
  roadDistanceMetres(
    market: MarketContext,
    from: GeoPoint,
    to: GeoPoint,
    vehicle: VehicleType,
  ): Promise<number>;
}
export const DISTANCE_PROVIDER = Symbol('DistanceProvider');

/** What {@link Geocoder} answers for an address it cannot place. */
export type GeocodeMiss = 'not-found' | 'unavailable';

/**
 * The point of a stop given by address and postcode, for a request without coordinates. The
 * point may be the postcode's centre when the address itself is not found.
 */
export interface Geocoder {
  locate(market: MarketContext, address: string, postcode: string): Promise<GeoPoint | GeocodeMiss>;
}
export const GEOCODER = Symbol('Geocoder');

/** The delivery settings and service areas of the Markets this deployment hosts. */
export interface MarketSettingsProvider {
  /** The settings of a hosted Market; the request's Market is always hosted. */
  get(marketId: MarketId): MarketDeliverySettings;
  /** The service area a postcode is in, or undefined outside every area. */
  areaFor(marketId: MarketId, postcode: string): ServiceArea | undefined;
}
export const MARKET_SETTINGS = Symbol('MarketSettingsProvider');
