import type {
  CallContext,
  GeoPoint,
  Id,
  MarketContext,
  MarketId,
} from '@mondapac-drive/shared-kernel';
import type { Breadcrumb, PurgeCutoffs } from '../domain/breadcrumb';
import type { LivePosition, NearbyCourier } from '../domain/live-position';
import type { DeliveryRoute, TrackedDelivery } from '../domain/tracked-delivery';
import type { TrackingLink } from '../domain/tracking-link';
import type { TrackingSettings } from '../domain/tracking-settings';
import type { VehicleType } from '../domain/vehicle';

/**
 * The couriers' live positions, per Market and tenant (Redis GEO in production, keys under
 * `tracking:`).
 * A position disappears `ttlSeconds` after it was saved, so an offline courier drops out of
 * every search. Calls run outside any unit of work.
 */
export interface LivePositionStore {
  /**
   * Takes the courier's ping slot for `intervalSeconds`. False when a ping of the courier was
   * accepted less than `intervalSeconds` ago: the caller refuses this one as throttled.
   */
  claimPingSlot(
    market: MarketContext,
    courierId: string,
    intervalSeconds: number,
  ): Promise<boolean>;
  /**
   * Saves the courier's latest position unless a later reading is already stored (pings can
   * arrive out of order). Answers whether it was saved.
   */
  save(market: MarketContext, position: LivePosition, ttlSeconds: number): Promise<boolean>;
  lastKnown(market: MarketContext, courierId: string): Promise<LivePosition | undefined>;
  /**
   * The couriers within `radiusMetres` of `point`, nearest first, at most `limit`. With a
   * service area, only couriers whose latest ping named that area.
   */
  nearest(
    market: MarketContext,
    point: GeoPoint,
    radiusMetres: number,
    limit: number,
    serviceAreaCode?: string,
  ): Promise<NearbyCourier[]>;
}
export const LIVE_POSITION_STORE = Symbol('LivePositionStore');

/**
 * Tracked deliveries, their breadcrumb trails and their customer links, in the `tracking`
 * schema. Every method runs inside the caller's unit of work.
 */
export interface TrackingRepository {
  findDelivery(
    market: MarketContext,
    deliveryId: Id<'Delivery'>,
  ): Promise<TrackedDelivery | undefined>;
  /** Inserts version 1, or saves version n + 1 over n; throws `StaleAggregateError` otherwise. */
  saveDelivery(market: MarketContext, delivery: TrackedDelivery): Promise<void>;
  /** The deliveries the courier carries that have not ended. */
  activeDeliveriesOf(market: MarketContext, courierId: string): Promise<TrackedDelivery[]>;
  appendBreadcrumbs(market: MarketContext, breadcrumbs: readonly Breadcrumb[]): Promise<void>;
  /** The delivery's trail in recorded order, at most `limit` points. */
  trailOf(market: MarketContext, deliveryId: Id<'Delivery'>, limit: number): Promise<Breadcrumb[]>;
  insertLink(market: MarketContext, link: TrackingLink): Promise<void>;
  findLink(market: MarketContext, tokenHash: string): Promise<TrackingLink | undefined>;
  /** Deletes at most `batch` rows of each kind past its cutoff; answers how many went. */
  purge(
    market: MarketContext,
    cutoffs: PurgeCutoffs,
    batch: number,
  ): Promise<{ breadcrumbs: number; deliveries: number; links: number }>;
}
export const TRACKING_REPOSITORY = Symbol('TrackingRepository');

/**
 * Where a delivery goes, read from the delivery module (its `DeliveryDispatchView`, system
 * context) when a lifecycle event names a delivery tracking has not seen yet. Undefined when
 * delivery does not know it, or has no point for a stop. Called outside any unit of work.
 */
export interface DeliveryRoutes {
  routeOf(context: CallContext, deliveryId: Id<'Delivery'>): Promise<DeliveryRoute | undefined>;
}
export const DELIVERY_ROUTES = Symbol('DeliveryRoutes');

/**
 * Time to travel from one point to another, in seconds, or undefined when no estimate can be
 * made. Bound to the platform's road routing (work package 12), which falls back to a
 * straight-line estimate by itself.
 */
export interface EtaProvider {
  etaSeconds(
    market: MarketContext,
    from: GeoPoint,
    to: GeoPoint,
    vehicle: VehicleType,
  ): Promise<number | undefined>;
}
export const ETA_PROVIDER = Symbol('EtaProvider');

export interface TrackingSettingsProvider {
  /** The settings of a hosted Market; the request's Market is always hosted. */
  get(marketId: MarketId): TrackingSettings;
}
export const TRACKING_SETTINGS = Symbol('TrackingSettingsProvider');

/** Unguessable tracking-link tokens and their stored hashes. */
export interface TrackingTokens {
  issue(): { readonly token: string; readonly hash: string };
  /** The hash of a presented token, or undefined when it does not have the shape of one. */
  hashOf(token: string): string | undefined;
}
export const TRACKING_TOKENS = Symbol('TrackingTokens');
