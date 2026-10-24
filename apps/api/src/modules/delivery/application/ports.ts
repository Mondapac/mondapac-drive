import type { GeoPoint, Id, MarketContext, MarketId } from '@mondapac-drive/shared-kernel';
import type { DeliveryState } from '../domain/delivery';
import type { DeliveryStatus } from '../domain/delivery-status';
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
  | 'createdAt'
> & {
  readonly vehicle: DeliveryState['quote']['vehicle'];
  readonly temperature: DeliveryState['parcel']['temperature'];
  readonly pickupPostcode: string;
  readonly dropoffPostcode: string;
  readonly total: DeliveryState['quote']['total'];
};
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
