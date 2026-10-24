import { defineEvent, eventField } from '@mondapac-drive/shared-kernel';
import { TEMPERATURES, VEHICLE_TYPES } from '../../domain/courier';

// The delivery lifecycle events as handoff 20 and the delivery thread fixed them, until delivery
// exports DELIVERY_BOOKED, DELIVERY_STATUS_CHANGED and DELIVERY_CANCELLED from its index (wave 2,
// handoff 21). Never registered in the catalogue here: the subscriptions only decode with them.
// Replaced by delivery's own definitions when that package is on main.

/** The delivery statuses as events carry them: lower-case kebab codes. */
const DELIVERY_STATUS_CODES = [
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
    vehicle: eventField.enumOf(VEHICLE_TYPES),
    temperature: eventField.enumOf(TEMPERATURES),
    windowStart: eventField.optional(eventField.instant()),
    windowEnd: eventField.optional(eventField.instant()),
  },
});

export const DELIVERY_STATUS_CHANGED = defineEvent({
  type: 'delivery.status-changed.v1',
  aggregateType: 'delivery',
  payload: {
    deliveryId: eventField.id(),
    status: eventField.enumOf(DELIVERY_STATUS_CODES),
    previousStatus: eventField.enumOf(DELIVERY_STATUS_CODES),
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
    previousStatus: eventField.enumOf(DELIVERY_STATUS_CODES),
    reason: eventField.enumOf(['merchant-cancelled', 'operator-cancelled'] as const),
  },
});
