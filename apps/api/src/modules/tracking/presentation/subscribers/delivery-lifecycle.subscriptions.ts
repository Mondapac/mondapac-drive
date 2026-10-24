import type { Id } from '@mondapac-drive/shared-kernel';
import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import {
  DELIVERY_BOOKED,
  DELIVERY_CANCELLED,
  DELIVERY_STATUS_CHANGED,
  type DeliveryStatusCode,
} from '../../../delivery';
import type {
  FollowDelivery,
  FollowDeliveryInput,
} from '../../application/use-cases/follow-delivery.use-case';
import type { TrackedStatus } from '../../domain/tracked-delivery';

/** The subscriber names: also the `handler` of `tracking.inbox`. */
export const DELIVERY_BOOKED_SUBSCRIBER = 'tracking.delivery-booked';
export const DELIVERY_STATUS_CHANGED_SUBSCRIBER = 'tracking.delivery-status-changed';
export const DELIVERY_CANCELLED_SUBSCRIBER = 'tracking.delivery-cancelled';

/** The event's lower-case code as tracking's copy of the delivery status (`picked-up` -> `PICKED_UP`). */
export function trackedStatusOf(code: DeliveryStatusCode): TrackedStatus {
  return code.toUpperCase().replaceAll('-', '_') as TrackedStatus;
}

/**
 * Tracking follows the delivery lifecycle (handoff 26): each delivery event goes, with the
 * delivery and the Market's system context, to `FollowDelivery`. A refusal throws, so the
 * delivery is retried and, after its last attempt, dead-lettered with an alert (P 6.4).
 */
export function deliveryLifecycleSubscriptions(follow: FollowDelivery): RegisteredSubscription[] {
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
      name: DELIVERY_BOOKED_SUBSCRIBER,
      event: DELIVERY_BOOKED,
      handle: (event, delivery, context) =>
        run(
          DELIVERY_BOOKED_SUBSCRIBER,
          {
            delivery,
            deliveryId: event.payload.deliveryId as Id<'Delivery'>,
            aggregateVersion: event.aggregateVersion,
            status: trackedStatusOf(event.payload.status),
          },
          context,
        ),
    }),
    subscription({
      name: DELIVERY_STATUS_CHANGED_SUBSCRIBER,
      event: DELIVERY_STATUS_CHANGED,
      handle: (event, delivery, context) =>
        run(
          DELIVERY_STATUS_CHANGED_SUBSCRIBER,
          {
            delivery,
            deliveryId: event.payload.deliveryId as Id<'Delivery'>,
            aggregateVersion: event.aggregateVersion,
            status: trackedStatusOf(event.payload.status),
            // The courier after the change: null when nobody carries the delivery.
            courierId: event.payload.courierId ?? null,
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
            aggregateVersion: event.aggregateVersion,
            status: 'CANCELLED',
          },
          context,
        ),
    }),
  ];
}
