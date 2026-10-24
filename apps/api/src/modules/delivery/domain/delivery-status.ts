/**
 * Delivery lifecycle. A scheduled delivery waits in SCHEDULED until dispatch opens; an on-demand
 * one starts in DISPATCHING. DELIVERED, CANCELLED and RETURNED are final.
 */
export const DELIVERY_STATUSES = [
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
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const DELIVERY_EVENT_TYPES = [
  'dispatch_opened',
  'courier_assigned',
  'courier_unassigned',
  'arrived_at_pickup',
  'picked_up',
  'arrived_at_dropoff',
  'delivered',
  'delivery_failed',
  'return_started',
  'returned',
  'cancelled',
] as const;
export type DeliveryEventType = (typeof DELIVERY_EVENT_TYPES)[number];

/** Each event: the statuses it may happen in, and the status it leads to. */
export const TRANSITIONS: Record<
  DeliveryEventType,
  { readonly from: readonly DeliveryStatus[]; readonly to: DeliveryStatus }
> = {
  dispatch_opened: { from: ['SCHEDULED'], to: 'DISPATCHING' },
  courier_assigned: { from: ['DISPATCHING'], to: 'ASSIGNED' },
  courier_unassigned: { from: ['ASSIGNED', 'AT_PICKUP'], to: 'DISPATCHING' },
  arrived_at_pickup: { from: ['ASSIGNED'], to: 'AT_PICKUP' },
  picked_up: { from: ['AT_PICKUP'], to: 'PICKED_UP' },
  arrived_at_dropoff: { from: ['PICKED_UP'], to: 'AT_DROPOFF' },
  delivered: { from: ['AT_DROPOFF'], to: 'DELIVERED' },
  delivery_failed: { from: ['PICKED_UP', 'AT_DROPOFF'], to: 'DELIVERY_FAILED' },
  return_started: { from: ['DELIVERY_FAILED'], to: 'RETURNING' },
  returned: { from: ['RETURNING'], to: 'RETURNED' },
  cancelled: { from: ['SCHEDULED', 'DISPATCHING', 'ASSIGNED', 'AT_PICKUP'], to: 'CANCELLED' },
};

export function isFinal(status: DeliveryStatus): boolean {
  return status === 'DELIVERED' || status === 'RETURNED' || status === 'CANCELLED';
}
