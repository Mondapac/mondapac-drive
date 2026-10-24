import type {
  CallContext,
  GeoPoint,
  Id,
  MarketContext,
  MarketId,
  Temporal,
} from '@mondapac-drive/shared-kernel';
import type { VehicleType } from '../domain/courier';
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
 * What dispatch tells the delivery module, after its own unit committed: a scheduled
 * delivery opened for dispatch, and a courier has it. Until work package 2 exports delivery's
 * use cases, the binding records nothing; `dispatch.courier-assigned` in the outbox is the fact.
 */
export interface DeliveryLink {
  dispatchOpened(context: CallContext, deliveryId: Id<'Delivery'>): Promise<void>;
  courierAssigned(
    context: CallContext,
    deliveryId: Id<'Delivery'>,
    courierId: Id<'Courier'>,
    vehicle: VehicleType,
  ): Promise<void>;
}
export const DELIVERY_LINK = Symbol('DeliveryLink');

/** The dispatch settings of the Markets this deployment hosts. */
export interface DispatchSettingsProvider {
  get(marketId: MarketId): DispatchSettings;
}
export const DISPATCH_SETTINGS = Symbol('DispatchSettingsProvider');
