import type {
  CallContext,
  GeoPoint,
  Id,
  MarketContext,
  MarketId,
  Money,
  Temporal,
} from '@mondapac-drive/shared-kernel';
import type { Temperature, VehicleType } from '../domain/courier';
import type { DispatchJob } from '../domain/dispatch-job';
import type { DispatchSettings } from '../domain/dispatch-settings';
import type { AvailableCourier, DispatchRequirements, NearbyCourier } from '../domain/matching';

/**
 * The dispatch jobs of one Market. Every method runs inside the caller's unit of work
 * (`platform/unit-of-work`): reads in a read-only or read-write unit, writes in a read-write one.
 */
export interface DispatchJobRepository {
  findById(market: MarketContext, id: Id<'DispatchJob'>): Promise<DispatchJob | undefined>;
  findByDelivery(
    market: MarketContext,
    deliveryId: Id<'Delivery'>,
  ): Promise<DispatchJob | undefined>;
  /** The open jobs whose next action is due at `now`, oldest first. */
  findDue(
    market: MarketContext,
    now: Temporal.Instant,
    limit: number,
  ): Promise<Id<'DispatchJob'>[]>;
  /** The job holding the offer of this id, or undefined. */
  findByOffer(
    market: MarketContext,
    offerId: Id<'DispatchOffer'>,
  ): Promise<DispatchJob | undefined>;
  /** The jobs where this courier holds a pending offer (the offer may have expired since). */
  findWithPendingOfferFor(market: MarketContext, courierId: Id<'Courier'>): Promise<DispatchJob[]>;
  /** Inserts a new job (version 1). Answers false, and writes nothing, when the delivery has one. */
  insert(market: MarketContext, job: DispatchJob): Promise<boolean>;
  /**
   * Saves `job` (version n + 1) over version n, with its new and changed offers. Throws
   * `StaleAggregateError` when the stored version is no longer n.
   */
  update(market: MarketContext, job: DispatchJob): Promise<void>;
}
export const DISPATCH_JOB_REPOSITORY = Symbol('DispatchJobRepository');

/**
 * Couriers on shift and free to take a delivery, with their vehicle (fleet's
 * `FleetDirectory.findEligibleCouriers`). Read before the unit of work opens.
 */
export interface CourierAvailability {
  findEligibleCouriers(
    context: CallContext,
    needs: DispatchRequirements,
  ): Promise<readonly AvailableCourier[]>;
}
export const COURIER_AVAILABILITY = Symbol('CourierAvailability');

/** Couriers' last known distance from a point (tracking's `CourierPositions`). */
export interface CourierProximity {
  nearestCouriers(
    context: CallContext,
    point: GeoPoint,
    options: {
      readonly radiusMetres: number;
      readonly limit: number;
      /** Only couriers whose latest position names this service area. */
      readonly serviceArea: string;
    },
  ): Promise<readonly NearbyCourier[]>;
}
export const COURIER_PROXIMITY = Symbol('CourierProximity');

/**
 * A stop of a delivery as dispatch reads it: no street address, contact name or phone (the
 * courier reads those on delivery's job after accepting).
 */
export interface DeliveryStop {
  /** From delivery's geocode; absent or null when delivery has none (handoff 34). */
  readonly suburb?: string | null;
  readonly postcode: string;
  readonly point: GeoPoint;
}

/** What dispatch needs to know about a delivery to offer it (delivery's `DeliveryDispatchView`). */
export interface DeliveryForDispatch {
  readonly status: string;
  readonly serviceAreaCode: string;
  readonly pickup: DeliveryStop;
  readonly dropoff: DeliveryStop;
  /** The quoted trip distance. */
  readonly distanceMetres: number;
  readonly weightGrams: number;
  readonly volumeLitres: number;
  readonly temperature: Temperature;
  /** The vehicle the delivery was quoted for. */
  readonly vehicle: VehicleType;
  readonly window?: { readonly start: Temporal.Instant; readonly end: Temporal.Instant };
}

/**
 * Delivery's read for dispatch, for the system actor only (event subscribers): `undefined` for a
 * delivery the Market does not have.
 */
export interface DeliveryFacts {
  forDispatch(
    context: CallContext,
    deliveryId: Id<'Delivery'>,
  ): Promise<DeliveryForDispatch | undefined>;
}
export const DELIVERY_FACTS = Symbol('DeliveryFacts');

/** Courier accounts as identity knows them. */
export interface CourierAccounts {
  /**
   * Whether the id names an active courier account of the Market, asked as the calling actor;
   * `undefined` when the actor may not ask (its role does not hold the courier view).
   */
  isActive(context: CallContext, accountId: string): Promise<boolean | undefined>;
}
export const COURIER_ACCOUNTS = Symbol('CourierAccounts');

/** The dispatch settings of the Markets this deployment hosts. */
export interface DispatchSettingsProvider {
  get(marketId: MarketId): DispatchSettings;
}
export const DISPATCH_SETTINGS = Symbol('DispatchSettingsProvider');

/** The delivery an offer prices: the facts delivery quoted it with. */
export interface OfferToPrice {
  readonly deliveryId: Id<'Delivery'>;
  readonly vehicle: VehicleType;
  readonly distanceMetres: number;
  readonly temperature: Temperature;
}

/**
 * What the signed-in courier will earn for an offered delivery (payouts' `EarningsQuote`), asked
 * as the courier; null when there is nothing to show (an employee, no payee profile, no rate).
 */
export interface OfferEarnings {
  forOffer(context: CallContext, offer: OfferToPrice): Promise<Money | null>;
}
export const OFFER_EARNINGS = Symbol('OfferEarnings');
