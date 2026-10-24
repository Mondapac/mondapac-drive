import type { Id } from '@mondapac-drive/shared-kernel';
import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import type {
  RecordDispatchAssignment,
  RecordDispatchExhausted,
} from '../../application/use-cases/dispatch-link.use-case';
import { DISPATCH_COURIER_ASSIGNED, DISPATCH_JOB_EXHAUSTED } from './dispatch-contract';

/** The subscriber names: also the `handler` of `delivery.inbox`. */
export const COURIER_ASSIGNED_SUBSCRIBER = 'delivery.courier-assigned';
export const DISPATCH_EXHAUSTED_SUBSCRIBER = 'delivery.dispatch-exhausted';

/**
 * Delivery's subscriptions to dispatch (the real `DeliveryLink`, handoff 21): an assignment is
 * recorded on the delivery, an exhausted job flags it for a dispatcher. Each hands the decoded
 * event, the delivery and the Market's system-actor context unchanged to one `system` use case; a
 * refusal throws, so the delivery is retried and, after its last attempt, dead-lettered.
 */
export function dispatchSubscriptions(
  recordAssignment: RecordDispatchAssignment,
  recordExhausted: RecordDispatchExhausted,
): RegisteredSubscription[] {
  return [
    subscription({
      name: COURIER_ASSIGNED_SUBSCRIBER,
      event: DISPATCH_COURIER_ASSIGNED,
      async handle(event, delivery, context) {
        const result = await recordAssignment.execute(context, {
          delivery,
          deliveryId: event.payload.deliveryId as Id<'Delivery'>,
          courierId: event.payload.courierId,
          vehicle: event.payload.vehicle,
        });
        if (!result.ok) {
          throw new Error(`${COURIER_ASSIGNED_SUBSCRIBER} refused: ${result.error.code}`);
        }
      },
    }),
    subscription({
      name: DISPATCH_EXHAUSTED_SUBSCRIBER,
      event: DISPATCH_JOB_EXHAUSTED,
      async handle(event, delivery, context) {
        const result = await recordExhausted.execute(context, {
          delivery,
          deliveryId: event.payload.deliveryId as Id<'Delivery'>,
        });
        if (!result.ok) {
          throw new Error(`${DISPATCH_EXHAUSTED_SUBSCRIBER} refused: ${result.error.code}`);
        }
      },
    }),
  ];
}
