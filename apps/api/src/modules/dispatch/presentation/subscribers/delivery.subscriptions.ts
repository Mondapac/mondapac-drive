import type { Id } from '@mondapac-drive/shared-kernel';
import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import type { CancelDispatchJob } from '../../application/use-cases/cancel-dispatch-job.use-case';
import type { FollowDeliveryStatus } from '../../application/use-cases/follow-delivery-status.use-case';
import type { OpenDispatchJob } from '../../application/use-cases/open-dispatch-job.use-case';
import { DELIVERY_BOOKED, DELIVERY_CANCELLED, DELIVERY_STATUS_CHANGED } from '../../../delivery';

/** The subscriber names: also the `handler` of `dispatch.inbox`. */
export const OPEN_JOB_SUBSCRIBER = 'dispatch.open-job';
export const FOLLOW_STATUS_SUBSCRIBER = 'dispatch.follow-delivery-status';
export const CANCEL_JOB_SUBSCRIBER = 'dispatch.cancel-job';

/**
 * Dispatch's subscriptions to the delivery lifecycle (handoff 20). Each is an entry adapter: the
 * dispatcher hands it the decoded event, the delivery and the Market's system-actor context,
 * which go unchanged to one `system` use case. A refusal throws, so the delivery is retried and,
 * after its last attempt, dead-lettered with an alert.
 */
export function deliverySubscriptions(
  open: OpenDispatchJob,
  follow: FollowDeliveryStatus,
  cancel: CancelDispatchJob,
): RegisteredSubscription[] {
  return [
    subscription({
      name: OPEN_JOB_SUBSCRIBER,
      event: DELIVERY_BOOKED,
      async handle(event, delivery, context) {
        const result = await open.execute(context, {
          delivery,
          deliveryId: event.payload.deliveryId as Id<'Delivery'>,
          deliveryVersion: event.aggregateVersion,
        });
        if (!result.ok) throw new Error(`${OPEN_JOB_SUBSCRIBER} refused: ${result.error.code}`);
      },
    }),
    subscription({
      name: FOLLOW_STATUS_SUBSCRIBER,
      event: DELIVERY_STATUS_CHANGED,
      async handle(event, delivery, context) {
        const { payload } = event;
        const result = await follow.execute(context, {
          delivery,
          deliveryId: payload.deliveryId as Id<'Delivery'>,
          deliveryVersion: event.aggregateVersion,
          status: payload.status,
          previousStatus: payload.previousStatus,
          courierId: (payload.courierId as Id<'Courier'> | null) ?? null,
          reason: payload.reason ?? null,
        });
        if (!result.ok) {
          throw new Error(`${FOLLOW_STATUS_SUBSCRIBER} refused: ${result.error.code}`);
        }
      },
    }),
    subscription({
      name: CANCEL_JOB_SUBSCRIBER,
      event: DELIVERY_CANCELLED,
      async handle(event, delivery, context) {
        const result = await cancel.execute(context, {
          delivery,
          deliveryId: event.payload.deliveryId as Id<'Delivery'>,
        });
        if (!result.ok) throw new Error(`${CANCEL_JOB_SUBSCRIBER} refused: ${result.error.code}`);
      },
    }),
  ];
}
