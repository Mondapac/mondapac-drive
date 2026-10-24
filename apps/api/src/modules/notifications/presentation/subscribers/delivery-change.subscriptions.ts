import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import type { RecordDeliveryChange } from '../../application/use-cases/record-delivery-change.use-case';
import { DELIVERY_BOOKED, DELIVERY_CANCELLED, DELIVERY_STATUS_CHANGED } from '../../../delivery';

/**
 * A status as the delivery API and the webhook body name it (`PICKED_UP`), from the event's
 * lower-case code (`picked-up`): the marketplace maps exactly these names (handoff 09b).
 */
export function apiStatus(code: string): string {
  return code.toUpperCase().replaceAll('-', '_');
}

/** The subscriber names: also the `handler` of `notifications.inbox`. */
export const DELIVERY_BOOKED_SUBSCRIBER = 'notifications.delivery-booked';
export const DELIVERY_STATUS_CHANGED_SUBSCRIBER = 'notifications.delivery-status-changed';
export const DELIVERY_CANCELLED_SUBSCRIBER = 'notifications.delivery-cancelled';

/**
 * Notifications' subscriptions to the delivery lifecycle (handoff 25): each event goes, with
 * the delivery and the Market's system context unchanged, to `RecordDeliveryChange`, which
 * queues the merchant's webhook calls and the recipient's SMS. A refusal throws, so the
 * delivery is retried and, after its last attempt, dead-lettered with an alert.
 */
export function deliveryChangeSubscriptions(
  record: RecordDeliveryChange,
): RegisteredSubscription[] {
  const refused = (name: string, code: string) => new Error(`${name} refused: ${code}`);
  return [
    subscription({
      name: DELIVERY_BOOKED_SUBSCRIBER,
      event: DELIVERY_BOOKED,
      async handle(event, delivery, context) {
        const result = await record.execute(context, {
          delivery,
          eventId: event.eventId,
          type: 'delivery.booked',
          occurredAt: event.occurredAt,
          deliveryId: event.payload.deliveryId,
          status: apiStatus(event.payload.status),
        });
        if (!result.ok) throw refused(DELIVERY_BOOKED_SUBSCRIBER, result.error.code);
      },
    }),
    subscription({
      name: DELIVERY_STATUS_CHANGED_SUBSCRIBER,
      event: DELIVERY_STATUS_CHANGED,
      async handle(event, delivery, context) {
        const { reason } = event.payload;
        const result = await record.execute(context, {
          delivery,
          eventId: event.eventId,
          type: 'delivery.status-changed',
          occurredAt: event.occurredAt,
          deliveryId: event.payload.deliveryId,
          status: apiStatus(event.payload.status),
          previousStatus: apiStatus(event.payload.previousStatus),
          ...(reason === null ? {} : { reason }),
        });
        if (!result.ok) throw refused(DELIVERY_STATUS_CHANGED_SUBSCRIBER, result.error.code);
      },
    }),
    subscription({
      name: DELIVERY_CANCELLED_SUBSCRIBER,
      event: DELIVERY_CANCELLED,
      async handle(event, delivery, context) {
        const result = await record.execute(context, {
          delivery,
          eventId: event.eventId,
          type: 'delivery.cancelled',
          occurredAt: event.occurredAt,
          deliveryId: event.payload.deliveryId,
          status: 'CANCELLED',
          previousStatus: apiStatus(event.payload.previousStatus),
          reason: event.payload.reason,
        });
        if (!result.ok) throw refused(DELIVERY_CANCELLED_SUBSCRIBER, result.error.code);
      },
    }),
  ];
}
