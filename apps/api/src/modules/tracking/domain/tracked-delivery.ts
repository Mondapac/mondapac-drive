import { err, ok } from '@mondapac-drive/shared-kernel';
import type { GeoPoint, Id, Result, Temporal } from '@mondapac-drive/shared-kernel';
import type { VehicleType } from './vehicle';

/**
 * The delivery statuses as the delivery module names them. Tracking keeps its own copy of the
 * vocabulary (a module never imports another's domain) and learns each change through
 * {@link TrackDelivery}, called by delivery and dispatch.
 */
export const TRACKED_STATUSES = [
  'SCHEDULED',
  'DISPATCHING',
  'ASSIGNED',
  'AT_PICKUP',
  'PICKED_UP',
  'AT_DROPOFF',
  'DELIVERED',
  'DELIVERY_FAILED',
  'RETURNING',
  'RETURNED',
  'CANCELLED',
] as const;
export type TrackedStatus = (typeof TRACKED_STATUSES)[number];

/**
 * What a customer may know of a delivery. `ended` covers every final or failed status: from
 * then on the tracking link shows nothing at all.
 */
export type TrackingPhase =
  'awaiting_courier' | 'heading_to_pickup' | 'on_the_way' | 'arriving' | 'ended';

const PHASES: Readonly<Record<TrackedStatus, TrackingPhase>> = Object.freeze({
  SCHEDULED: 'awaiting_courier',
  DISPATCHING: 'awaiting_courier',
  ASSIGNED: 'heading_to_pickup',
  AT_PICKUP: 'heading_to_pickup',
  PICKED_UP: 'on_the_way',
  AT_DROPOFF: 'arriving',
  DELIVERED: 'ended',
  DELIVERY_FAILED: 'ended',
  RETURNING: 'ended',
  RETURNED: 'ended',
  CANCELLED: 'ended',
});

export function phaseOf(status: TrackedStatus): TrackingPhase {
  return PHASES[status];
}

/** The courier's position is shown to the customer from pickup until drop-off only. */
export function showsCourierToCustomer(phase: TrackingPhase): boolean {
  return phase === 'on_the_way' || phase === 'arriving';
}

/** Tracking's view of one delivery: who carries it, where it goes, and how far it has got. */
export interface TrackedDelivery {
  readonly deliveryId: Id<'Delivery'>;
  readonly status: TrackedStatus;
  readonly courierId?: string;
  readonly vehicle?: VehicleType;
  readonly pickup: GeoPoint;
  readonly dropoff: GeoPoint;
  readonly startedAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
  /** Set once the delivery reaches an `ended` phase; it never changes after that. */
  readonly endedAt?: Temporal.Instant;
  readonly version: number;
}

/** A change reported by delivery or dispatch. */
export interface TrackingUpdate {
  readonly status: TrackedStatus;
  /** The assigned courier; absent when nobody carries the delivery (yet, or any more). */
  readonly courierId?: string;
  readonly vehicle?: VehicleType;
}

export type TrackingRefusal = { readonly code: 'tracking.ended' };

export function startTracking(
  input: {
    readonly deliveryId: Id<'Delivery'>;
    readonly pickup: GeoPoint;
    readonly dropoff: GeoPoint;
  } & TrackingUpdate,
  now: Temporal.Instant,
): TrackedDelivery {
  const ended = phaseOf(input.status) === 'ended';
  return {
    deliveryId: input.deliveryId,
    status: input.status,
    ...courierOf(input),
    pickup: input.pickup,
    dropoff: input.dropoff,
    startedAt: now,
    updatedAt: now,
    ...(ended ? { endedAt: now } : {}),
    version: 1,
  };
}

/**
 * Applies a reported change. An ended delivery refuses every further change, so its trail and
 * link stay closed. A report that changes nothing answers the same state (a redelivered event).
 */
export function updateTracking(
  state: TrackedDelivery,
  update: TrackingUpdate,
  now: Temporal.Instant,
): Result<TrackedDelivery, TrackingRefusal> {
  if (state.endedAt !== undefined) return err({ code: 'tracking.ended' });
  if (
    state.status === update.status &&
    state.courierId === update.courierId &&
    state.vehicle === update.vehicle
  ) {
    return ok(state);
  }
  const ended = phaseOf(update.status) === 'ended';
  return ok({
    deliveryId: state.deliveryId,
    status: update.status,
    ...courierOf(update),
    pickup: state.pickup,
    dropoff: state.dropoff,
    startedAt: state.startedAt,
    updatedAt: now,
    ...(ended ? { endedAt: now } : {}),
    version: state.version + 1,
  });
}

/** Whether a ping of the delivery's courier adds to its breadcrumb trail. */
export function recordsTrail(delivery: TrackedDelivery, courierId: string): boolean {
  const phase = phaseOf(delivery.status);
  return (
    delivery.endedAt === undefined &&
    delivery.courierId === courierId &&
    phase !== 'awaiting_courier' &&
    phase !== 'ended'
  );
}

function courierOf(update: TrackingUpdate): Pick<TrackedDelivery, 'courierId' | 'vehicle'> {
  return {
    ...(update.courierId === undefined ? {} : { courierId: update.courierId }),
    ...(update.vehicle === undefined ? {} : { vehicle: update.vehicle }),
  };
}
