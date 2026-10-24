import type { MarketId, Temporal } from '@mondapac-drive/shared-kernel';

/**
 * The delivery facts a merchant can subscribe to, named as the delivery module's outbox events
 * without their version suffix. The webhook body carries the same name in `type`.
 */
export const WEBHOOK_EVENT_TYPES = [
  'delivery.booked',
  'delivery.status-changed',
  'delivery.cancelled',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export function isWebhookEventType(value: string): value is WebhookEventType {
  return (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}

/** The recipient SMS of a delivery, in lifecycle order. */
export const SMS_KINDS = ['booked', 'on_the_way', 'delivered', 'failed'] as const;
export type SmsKind = (typeof SMS_KINDS)[number];

/**
 * One change of a delivery, as the notifications module consumes it from the delivery outbox
 * (`delivery.booked`, `delivery.status-changed`, `delivery.cancelled`). It carries no personal
 * data: the recipient's phone number is looked up when an SMS is sent, never stored here.
 */
export interface DeliveryChange {
  /** The outbox event id: the idempotency key of everything this change sends. */
  readonly eventId: string;
  readonly type: WebhookEventType;
  readonly occurredAt: Temporal.Instant;
  readonly deliveryId: string;
  readonly merchantId: string;
  readonly externalReference: string;
  /** The delivery's status after the change, as the delivery module names it. */
  readonly status: string;
  readonly previousStatus?: string;
  /** A failure or cancellation reason code, never free text. */
  readonly reason?: string;
}

/** The recipient SMS a change sends, if any: booked, picked up, delivered or failed. */
export function smsKindFor(change: DeliveryChange): SmsKind | undefined {
  if (change.type === 'delivery.booked') return 'booked';
  if (change.type !== 'delivery.status-changed') return undefined;
  switch (change.status) {
    case 'PICKED_UP':
      return 'on_the_way';
    case 'DELIVERED':
      return 'delivered';
    case 'DELIVERY_FAILED':
      return 'failed';
    default:
      return undefined;
  }
}

/** The JSON a merchant's endpoint receives for a change: the same bytes on every attempt. */
export interface WebhookBody {
  readonly id: string;
  readonly type: WebhookEventType;
  readonly occurredAt: string;
  readonly marketId: MarketId;
  readonly data: {
    readonly deliveryId: string;
    readonly externalReference: string;
    readonly status: string;
    readonly previousStatus?: string;
    readonly reason?: string;
  };
}

export function webhookBody(marketId: MarketId, change: DeliveryChange): WebhookBody {
  return {
    id: change.eventId,
    type: change.type,
    occurredAt: change.occurredAt.toString(),
    marketId,
    data: {
      deliveryId: change.deliveryId,
      externalReference: change.externalReference,
      status: change.status,
      ...(change.previousStatus === undefined ? {} : { previousStatus: change.previousStatus }),
      ...(change.reason === undefined ? {} : { reason: change.reason }),
    },
  };
}
