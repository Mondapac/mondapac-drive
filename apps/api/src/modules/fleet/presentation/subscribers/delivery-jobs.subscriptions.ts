import type { Id } from '@mondapac-drive/shared-kernel';
import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import { DELIVERY_CANCELLED, DELIVERY_STATUS_CHANGED } from '../../../delivery';
import type {
  FollowDelivery,
  FollowDeliveryInput,
} from '../../application/use-cases/follow-delivery.use-case';

/** The subscriber names: also the `handler` of `fleet.inbox`. */
export const DELIVERY_STATUS_SUBSCRIBER = 'fleet.follow-delivery-status';
export const DELIVERY_CANCELLED_SUBSCRIBER = 'fleet.follow-delivery-cancelled';

/**
 * Fleet follows the deliveries couriers carry (handoff 31): each status change and cancel goes,
 * with the delivery and the Market's system context, to `FollowDelivery`. Booking is not
 * followed: nobody carries a delivery before it is assigned. A refusal throws, so the delivery is
 * retried and, after its last attempt, dead-lettered with an alert (P 6.4).
 */
export function deliveryJobSubscriptions(follow: FollowDelivery): RegisteredSubscription[] {
  const run = async (
    name: string,
    input: FollowDeliveryInput,
    context: Parameters<FollowDelivery['execute']>[0],
  ) => {
    const result = await follow.execute(context, input);
    if (!result.ok) throw new Error(`${name} refused: ${result.error.code}`);
  };
  return [
    subscription({
      name: DELIVERY_STATUS_SUBSCRIBER,
      event: DELIVERY_STATUS_CHANGED,
      handle: (event, delivery, context) =>
        run(
          DELIVERY_STATUS_SUBSCRIBER,
          {
            delivery,
            deliveryId: event.payload.deliveryId as Id<'Delivery'>,
            deliveryVersion: event.aggregateVersion,
            status: event.payload.status,
            // The courier after the change: null when nobody carries the delivery.
            courierAccountId: event.payload.courierId ?? null,
            occurredAt: event.occurredAt,
          },
          context,
        ),
    }),
    subscription({
      name: DELIVERY_CANCELLED_SUBSCRIBER,
      event: DELIVERY_CANCELLED,
      handle: (event, delivery, context) =>
        run(
          DELIVERY_CANCELLED_SUBSCRIBER,
          {
            delivery,
            deliveryId: event.payload.deliveryId as Id<'Delivery'>,
            deliveryVersion: event.aggregateVersion,
            status: 'cancelled',
            courierAccountId: null,
            occurredAt: event.occurredAt,
          },
          context,
        ),
    }),
  ];
}
