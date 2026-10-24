import type {
  CallContext,
  GeoPoint,
  Id,
  MarketContext,
  MarketId,
} from '@mondapac-drive/shared-kernel';
import type { DeliveryException, DeliveryState } from '../domain/delivery';
import type { DeliveryStatus } from '../domain/delivery-status';
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
   * Saves `delivery` over version `fromVersion` (by default the one before it: one step) and
   * appends its new history entries. Throws `StaleAggregateError` when the stored version is no
   * longer `fromVersion`.
   */
  update(market: MarketContext, delivery: DeliveryState, fromVersion?: number): Promise<void>;
  /**
   * Flags the delivery for a dispatcher while it is still in `whileStatus`, without a new version
   * (the flag is not a lifecycle step and publishes no event). Answers false, and writes nothing,
   * when the delivery is missing or has moved on. An assignment or a cancel clears the flag.
   */
  raiseException(
    market: MarketContext,
    id: Id<'Delivery'>,
    exception: DeliveryException,
    whileStatus: DeliveryStatus,
  ): Promise<boolean>;
  /**
   * Up to `limit` deliveries of the Market matching `filter`, newest first (by id: UUIDv7), whose
   * id is lower than `before` (all when absent). Summaries only: no stop contact or history.
   */
  list(market: MarketContext, filter: DeliveryListFilter): Promise<DeliverySummary[]>;
}

/** What the operations panel filters the delivery list by; every field narrows. */
export interface DeliveryListFilter {
  readonly statuses?: readonly DeliveryStatus[];
  readonly merchantId?: string;
  readonly courierId?: string;
  readonly before?: Id<'Delivery'>;
  readonly limit: number;
}

/**
 * One row of the delivery list: what a dispatcher needs to pick a delivery, without the stops'
 * addresses and contacts (personal data, read on the detail page only).
 */
export type DeliverySummary = Pick<
  DeliveryState,
  | 'id'
  | 'merchantId'
  | 'externalReference'
  | 'serviceAreaCode'
  | 'mode'
  | 'window'
  | 'status'
  | 'courierId'
  | 'exception'
  | 'createdAt'
> & {
  readonly vehicle: DeliveryState['quote']['vehicle'];
  readonly temperature: DeliveryState['parcel']['temperature'];
  readonly pickupPostcode: string;
  readonly dropoffPostcode: string;
  /** The stops' points rounded to 4 decimals (about 11 m): enough to pin them on the live map. */
  readonly pickupPoint: GeoPoint;
  readonly dropoffPoint: GeoPoint;
  readonly total: DeliveryState['quote']['total'];
};
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

/** Courier accounts as identity knows them. */
export interface CourierAccounts {
  /**
   * Whether the id names an active courier account of the Market, asked as the calling actor;
   * `undefined` when the actor may not ask (its role does not hold the courier view).
   */
  isActive(context: CallContext, accountId: string): Promise<boolean | undefined>;
}
export const COURIER_ACCOUNTS = Symbol('CourierAccounts');
