import { defineEvent, eventField, type Id, type PendingEvent } from '@mondapac-drive/shared-kernel';
import type { DeliveryHistoryEntry, DeliveryState } from '../delivery';
import { DELIVERY_STATUSES, type DeliveryStatus } from '../delivery-status';
import { TEMPERATURES } from '../parcel';
import {
  CANCEL_REASON_CODES,
  STATUS_REASON_CODES,
  type CancelReasonCode,
  type DeliveryReasonCode,
  type StatusReasonCode,
} from '../reason-codes';
import { VEHICLE_TYPES } from '../vehicle';

export { CANCEL_REASON_CODES, STATUS_REASON_CODES };
export type { CancelReasonCode, DeliveryReasonCode, StatusReasonCode };

// The delivery module's events (platform persistence design 5.3; wave 2 contract, handoff 20).
// Aggregate `delivery`, one event per aggregate version, ids and codes only: no name, phone,
// address or free text. The kernel has no free-string field kind, so the merchant's external
// reference is read with `DeliveryRecipients`, never carried here.

/** An event's status: the domain's status as a lower-case code (`AT_PICKUP` is `at-pickup`). */
export const DELIVERY_STATUS_CODES = [
  'scheduled',
  'dispatching',
  'assigned',
  'at-pickup',
  'picked-up',
  'at-dropoff',
  'delivered',
  'delivery-failed',
  'returning',
  'returned',
  'cancelled',
] as const;
export type DeliveryStatusCode = (typeof DELIVERY_STATUS_CODES)[number];

export function statusCode(status: DeliveryStatus): DeliveryStatusCode {
  return status.toLowerCase().replaceAll('_', '-') as DeliveryStatusCode;
}

export const DELIVERY_BOOKED = defineEvent({
  type: 'delivery.booked.v1',
  aggregateType: 'delivery',
  payload: {
    deliveryId: eventField.id(),
    merchantId: eventField.id(),
    status: eventField.enumOf(DELIVERY_STATUS_CODES),
    vehicle: eventField.enumOf(VEHICLE_TYPES),
    temperature: eventField.enumOf(TEMPERATURES),
    windowStart: eventField.optional(eventField.instant()),
    windowEnd: eventField.optional(eventField.instant()),
  },
});

/** Any lifecycle step but a cancel. `courierId` is the courier after the change. */
export const DELIVERY_STATUS_CHANGED = defineEvent({
  type: 'delivery.status-changed.v1',
  aggregateType: 'delivery',
  payload: {
    deliveryId: eventField.id(),
    status: eventField.enumOf(DELIVERY_STATUS_CODES),
    previousStatus: eventField.enumOf(DELIVERY_STATUS_CODES),
    courierId: eventField.optional(eventField.id()),
    reason: eventField.optional(eventField.enumOf(STATUS_REASON_CODES)),
  },
});

export const DELIVERY_CANCELLED = defineEvent({
  type: 'delivery.cancelled.v1',
  aggregateType: 'delivery',
  payload: {
    deliveryId: eventField.id(),
    previousStatus: eventField.enumOf(DELIVERY_STATUS_CODES),
    reason: eventField.enumOf(CANCEL_REASON_CODES),
  },
});

export const DELIVERY_EVENTS = [
  DELIVERY_BOOKED,
  DELIVERY_STATUS_CHANGED,
  DELIVERY_CANCELLED,
] as const;

// The domain's status list and the event's codes must stay one to one.
if (DELIVERY_STATUSES.map(statusCode).join() !== DELIVERY_STATUS_CODES.join()) {
  throw new Error('delivery events: DELIVERY_STATUS_CODES does not match DELIVERY_STATUSES');
}

/** The event of a new delivery (version 1). */
export function bookedEvent(delivery: DeliveryState): PendingEvent {
  return DELIVERY_BOOKED.record({
    aggregateId: delivery.id,
    aggregateVersion: delivery.version,
    occurredAt: delivery.createdAt,
    payload: {
      deliveryId: delivery.id,
      merchantId: delivery.merchantId as Id,
      status: statusCode(delivery.status),
      vehicle: delivery.quote.vehicle,
      temperature: delivery.parcel.temperature,
      windowStart: delivery.window?.start ?? null,
      windowEnd: delivery.window?.end ?? null,
    },
  });
}

/**
 * The events of the changes from `before` to `after`: one per new history entry, each with the
 * version it produced (before.version + 1, + 2, ...). A cancel is `delivery.cancelled`, every
 * other step `delivery.status-changed`.
 */
export function changeEvents(before: DeliveryState, after: DeliveryState): PendingEvent[] {
  const added = after.history.slice(before.history.length);
  if (before.version + added.length !== after.version) {
    throw new Error('delivery events: one history entry per version is required');
  }
  let previous = before.status;
  let courierId = before.courierId ?? null;
  return added.map((entry, index) => {
    const aggregateVersion = before.version + index + 1;
    if (entry.type === 'courier_assigned') courierId = entry.courierId ?? null;
    if (entry.type === 'courier_unassigned') courierId = null;
    const event = eventOf(entry, previous, courierId, after.id, aggregateVersion);
    previous = entry.status;
    return event;
  });
}

function eventOf(
  entry: DeliveryHistoryEntry,
  previous: DeliveryStatus,
  courierId: string | null,
  deliveryId: Id<'Delivery'>,
  aggregateVersion: number,
): PendingEvent {
  const base = { aggregateId: deliveryId, aggregateVersion, occurredAt: entry.at };
  if (entry.type === 'cancelled') {
    return DELIVERY_CANCELLED.record({
      ...base,
      payload: {
        deliveryId,
        previousStatus: statusCode(previous),
        reason: cancelReasonOf(entry.reasonCode),
      },
    });
  }
  return DELIVERY_STATUS_CHANGED.record({
    ...base,
    payload: {
      deliveryId,
      status: statusCode(entry.status),
      previousStatus: statusCode(previous),
      courierId: courierId as Id | null,
      reason: statusReasonOf(entry),
    },
  });
}

function cancelReasonOf(code: DeliveryReasonCode | undefined): CancelReasonCode {
  if (code === 'merchant-cancelled' || code === 'operator-cancelled') return code;
  throw new Error('delivery events: a cancel needs its reason code');
}

function statusReasonOf(entry: DeliveryHistoryEntry): StatusReasonCode | null {
  if (entry.type === 'delivery_failed') return 'delivery-failed';
  if (entry.type === 'courier_unassigned') {
    return entry.reasonCode === 'courier-reassigned'
      ? 'courier-reassigned'
      : 'dispatcher-unassigned';
  }
  return null;
}
