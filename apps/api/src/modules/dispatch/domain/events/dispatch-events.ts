import { defineEvent, eventField } from '@mondapac-drive/shared-kernel';
import { VEHICLE_TYPES } from '../courier';

// The dispatch module's events (platform persistence design 5.3). An offer is its own aggregate
// (version 1 when sent, 2 when it is answered, expires or is withdrawn), so that one wave can
// send several offers in one change; the job's events carry the job's version.

export const OFFER_SENT = defineEvent({
  type: 'dispatch.offer-sent.v1',
  aggregateType: 'dispatch-offer',
  payload: {
    jobId: eventField.id(),
    deliveryId: eventField.id(),
    courierId: eventField.id(),
    round: eventField.integer(),
    expiresAt: eventField.instant(),
  },
});

export const OFFER_ACCEPTED = defineEvent({
  type: 'dispatch.offer-accepted.v1',
  aggregateType: 'dispatch-offer',
  payload: { jobId: eventField.id(), deliveryId: eventField.id(), courierId: eventField.id() },
});

export const OFFER_DECLINED = defineEvent({
  type: 'dispatch.offer-declined.v1',
  aggregateType: 'dispatch-offer',
  payload: { jobId: eventField.id(), deliveryId: eventField.id(), courierId: eventField.id() },
});

export const OFFER_EXPIRED = defineEvent({
  type: 'dispatch.offer-expired.v1',
  aggregateType: 'dispatch-offer',
  payload: { jobId: eventField.id(), deliveryId: eventField.id(), courierId: eventField.id() },
});

/** Another courier took the delivery, a dispatcher assigned it, or it was cancelled. */
export const OFFER_WITHDRAWN = defineEvent({
  type: 'dispatch.offer-withdrawn.v1',
  aggregateType: 'dispatch-offer',
  payload: { jobId: eventField.id(), deliveryId: eventField.id(), courierId: eventField.id() },
});

/** A courier has the delivery: by accepting an offer, or assigned by a dispatcher. */
export const COURIER_ASSIGNED = defineEvent({
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

/** Every round went unanswered: a dispatcher must assign the delivery by hand. */
export const JOB_EXHAUSTED = defineEvent({
  type: 'dispatch.job-exhausted.v1',
  aggregateType: 'dispatch-job',
  payload: { deliveryId: eventField.id(), rounds: eventField.integer() },
});

export const DISPATCH_EVENTS = [
  OFFER_SENT,
  OFFER_ACCEPTED,
  OFFER_DECLINED,
  OFFER_EXPIRED,
  OFFER_WITHDRAWN,
  COURIER_ASSIGNED,
  JOB_EXHAUSTED,
] as const;
