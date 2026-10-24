import type { MarketId, Temporal } from '@mondapac-drive/shared-kernel';
import type { WebhookEventType } from './delivery-change';
import { NotificationsDomainError } from './errors';
import type { WebhookUrl } from './webhook-url';

/** The most active subscriptions one merchant may hold in a Market. */
export const MAX_SUBSCRIPTIONS_PER_MERCHANT = 10;

export type SubscriptionStatus = 'active' | 'disabled';

/**
 * A merchant's webhook endpoint. The signing secret is never stored: it is derived from the
 * deployment's webhook key, the subscription id and `secretVersion`, so rotating it is one
 * version step and the old secret stops working at once. The URL never changes; a new URL is a
 * new subscription.
 */
export interface WebhookSubscription {
  readonly id: string;
  readonly marketId: MarketId;
  readonly merchantId: string;
  readonly url: WebhookUrl;
  readonly eventTypes: readonly WebhookEventType[];
  readonly secretVersion: number;
  readonly status: SubscriptionStatus;
  readonly createdAt: Temporal.Instant;
  readonly version: number;
}

export interface NewSubscription {
  readonly id: string;
  readonly marketId: MarketId;
  readonly merchantId: string;
  readonly url: WebhookUrl;
  readonly eventTypes: readonly WebhookEventType[];
  readonly createdAt: Temporal.Instant;
}

export function createSubscription(input: NewSubscription): WebhookSubscription {
  if (input.eventTypes.length === 0) {
    throw new NotificationsDomainError(
      'webhook-subscription.no-event-types',
      'A subscription names at least one event type',
    );
  }
  return {
    ...input,
    eventTypes: [...new Set(input.eventTypes)].sort(),
    secretVersion: 1,
    status: 'active',
    version: 1,
  };
}

/** Whether a change of this type goes to this subscription. */
export function wants(subscription: WebhookSubscription, type: WebhookEventType): boolean {
  return subscription.status === 'active' && subscription.eventTypes.includes(type);
}

/** The next secret: deliveries signed after this use only the new one. */
export function rotateSecret(subscription: WebhookSubscription): WebhookSubscription {
  if (subscription.status !== 'active') {
    throw new NotificationsDomainError(
      'webhook-subscription.disabled',
      'A disabled subscription has no secret to rotate',
    );
  }
  return {
    ...subscription,
    secretVersion: subscription.secretVersion + 1,
    version: subscription.version + 1,
  };
}

/** Stops new deliveries; pending ones are dead-lettered when they come due. */
export function disableSubscription(subscription: WebhookSubscription): WebhookSubscription {
  if (subscription.status === 'disabled') return subscription;
  return { ...subscription, status: 'disabled', version: subscription.version + 1 };
}
