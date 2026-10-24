import { defineEvent, eventField } from '@mondapac-drive/shared-kernel';
import { VEHICLE_TYPES } from '../../domain/vehicle';

// The two dispatch events delivery consumes, declared here as dispatch publishes them: delivery
// does not import dispatch (dispatch imports delivery for its reads, and a module graph has no
// cycles). Only the type and the fields matter to the dispatcher's decoding; the contracts test
// (test/contracts/delivery-consumed-events.contract.spec.ts) holds each one equal to the entry of
// the checked-in event catalogue snapshot, so a change on dispatch's side fails CI here.

export const DISPATCH_COURIER_ASSIGNED = defineEvent({
  type: 'dispatch.courier-assigned.v1',
  aggregateType: 'dispatch-job',
  payload: {
    deliveryId: eventField.id(),
    courierId: eventField.id(),
    vehicle: eventField.enumOf(VEHICLE_TYPES),
    method: eventField.enumOf(['offer', 'manual'] as const),
    previousCourierId: eventField.optional(eventField.id()),
  },
});

export const DISPATCH_JOB_EXHAUSTED = defineEvent({
  type: 'dispatch.job-exhausted.v1',
  aggregateType: 'dispatch-job',
  payload: { deliveryId: eventField.id(), rounds: eventField.integer() },
});

export const CONSUMED_DISPATCH_EVENTS = [
  DISPATCH_COURIER_ASSIGNED,
  DISPATCH_JOB_EXHAUSTED,
] as const;
