import type { DeliveryStatus } from '../api/schemas';

/**
 * The courier's part of the delivery lifecycle (modules/delivery domain/delivery-status.ts).
 * The API enforces it; the app uses it to offer only the step that can succeed.
 */
export type CourierStep =
  'arrive_at_pickup' | 'pick_up' | 'arrive_at_dropoff' | 'deliver' | 'finished' | 'waiting';

const STEP: Readonly<Record<DeliveryStatus, CourierStep>> = {
  SCHEDULED: 'waiting',
  DISPATCHING: 'waiting',
  ASSIGNED: 'arrive_at_pickup',
  AT_PICKUP: 'pick_up',
  PICKED_UP: 'arrive_at_dropoff',
  AT_DROPOFF: 'deliver',
  DELIVERED: 'finished',
  DELIVERY_FAILED: 'finished',
  RETURNING: 'finished',
  RETURNED: 'finished',
  CANCELLED: 'finished',
};

export function nextStep(status: DeliveryStatus): CourierStep {
  return STEP[status];
}

/** A failed delivery can be reported once the goods are on board (the API's delivery_failed). */
export function canReportFailure(status: DeliveryStatus): boolean {
  return status === 'PICKED_UP' || status === 'AT_DROPOFF';
}

/** Which stop the courier is heading to or standing at. */
export function currentStop(status: DeliveryStatus): 'pickup' | 'dropoff' | null {
  switch (status) {
    case 'ASSIGNED':
    case 'AT_PICKUP':
      return 'pickup';
    case 'PICKED_UP':
    case 'AT_DROPOFF':
      return 'dropoff';
    default:
      return null;
  }
}
