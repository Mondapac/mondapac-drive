import { defineEvent, eventField } from '@mondapac-drive/shared-kernel';

// The facts the fleet module publishes through its outbox. Dispatch (work package 07) follows
// them to keep its pool of available couriers; payouts and tracking may follow them later.
// Payloads hold ids, codes and flags only: never a name, a document or a place.

export const courierWentOnline = defineEvent({
  type: 'fleet.courier-went-online.v1',
  aggregateType: 'courier',
  payload: { courierId: eventField.id() },
});

/** `cause`: the courier ended the shift, or the operator offboarded the courier. */
export const courierWentOffline = defineEvent({
  type: 'fleet.courier-went-offline.v1',
  aggregateType: 'courier',
  payload: {
    courierId: eventField.id(),
    cause: eventField.enumOf(['courier', 'offboarded'] as const),
  },
});

/** A suspended courier is offline too; `wasOnline` says whether a shift was ended by it. */
export const courierSuspended = defineEvent({
  type: 'fleet.courier-suspended.v1',
  aggregateType: 'courier',
  payload: { courierId: eventField.id(), wasOnline: eventField.boolean() },
});

export const FLEET_EVENTS = [courierWentOnline, courierWentOffline, courierSuspended] as const;
