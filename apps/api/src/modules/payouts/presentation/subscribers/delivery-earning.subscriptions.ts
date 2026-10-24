import { DELIVERY_STATUS_CHANGED } from '../../../delivery';
import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import type { RecordDeliveryEarning } from '../../application/use-cases/record-delivery-earning.use-case';

/** The subscriber name: also the `handler` of `payouts.inbox`. */
export const DELIVERY_EARNING_SUBSCRIBER = 'payouts.delivery-earning';

/**
 * Payouts' subscription to delivery: a delivery that reaches `delivered` with a courier records
 * that courier's earning, once (the unit records the event in the inbox). Every other status is
 * ignored. A refusal throws, so the event is retried and, after its last attempt, dead-lettered.
 */
export function deliveryEarningSubscriptions(
  recordEarning: RecordDeliveryEarning,
): RegisteredSubscription[] {
  return [
    subscription({
      name: DELIVERY_EARNING_SUBSCRIBER,
      event: DELIVERY_STATUS_CHANGED,
      async handle(event, delivery, context) {
        const { deliveryId, status, courierId } = event.payload;
        if (status !== 'delivered' || courierId === null) return;
        const result = await recordEarning.execute(context, {
          deliveryId,
          courierId,
          deliveredAt: event.occurredAt,
          event: delivery,
        });
        if (!result.ok) {
          throw new Error(`${DELIVERY_EARNING_SUBSCRIBER} refused: ${result.error.code}`);
        }
      },
    }),
  ];
}
