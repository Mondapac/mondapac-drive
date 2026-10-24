import { defineEvent, eventField } from '@mondapac-drive/shared-kernel';

// STAND-IN until package 21 merges: a copy of the delivery.* contract the delivery thread fixed
// (handoff 20, with its changes: no externalReference in any payload, reason is a code, and
// statuses are lower-case kebab codes).
// On the rebase after 21 this file goes, and the subscriptions import DELIVERY_BOOKED,
// DELIVERY_STATUS_CHANGED and DELIVERY_CANCELLED from '../../../delivery'.

const STATUSES = [
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

export const DELIVERY_BOOKED = defineEvent({
  type: 'delivery.booked.v1',
  aggregateType: 'delivery',
  payload: {
    deliveryId: eventField.id(),
    merchantId: eventField.id(),
    status: eventField.enumOf(['scheduled', 'dispatching'] as const),
    vehicle: eventField.enumOf(['bicycle', 'motorbike', 'car', 'van'] as const),
    temperature: eventField.enumOf(['ambient', 'chilled', 'frozen'] as const),
    windowStart: eventField.optional(eventField.instant()),
    windowEnd: eventField.optional(eventField.instant()),
  },
});

export const DELIVERY_STATUS_CHANGED = defineEvent({
  type: 'delivery.status-changed.v1',
  aggregateType: 'delivery',
  payload: {
    deliveryId: eventField.id(),
    status: eventField.enumOf(STATUSES),
    previousStatus: eventField.enumOf(STATUSES),
    courierId: eventField.optional(eventField.id()),
    reason: eventField.optional(
      eventField.enumOf([
        'dispatcher-unassigned',
        'courier-reassigned',
        'delivery-failed',
      ] as const),
    ),
  },
});

export const DELIVERY_CANCELLED = defineEvent({
  type: 'delivery.cancelled.v1',
  aggregateType: 'delivery',
  payload: {
    deliveryId: eventField.id(),
    previousStatus: eventField.enumOf(STATUSES),
    reason: eventField.enumOf(['merchant-cancelled', 'operator-cancelled'] as const),
  },
});
