import { Temporal, type MarketId } from '@mondapac-drive/shared-kernel';
import type { WebhookEventType } from './delivery-change';
import { NotificationsDomainError } from './errors';
import type { WebhookUrl } from './webhook-url';

/** The most active subscriptions one merchant may hold in a Market. */
export const MAX_SUBSCRIPTIONS_PER_MERCHANT = 10;

export type SubscriptionStatus = 'active' | 'disabled';

/** The longest a rotated-out secret may keep signing next to the new one. */
export const MAX_ROTATION_OVERLAP_SECONDS = 7 * 24 * 3600;

/**
 * A merchant's webhook endpoint. The signing secret is never stored: it is derived from the
 * deployment's webhook key, the subscription id and `secretVersion`, so rotating it is one
 * version step. The previous secret keeps signing, next to the new one, until
 * `previousSecretValidUntil` (the Market's rotation overlap), so the merchant can switch its
 * receiver without dropping a call. The URL never changes; a new URL is a new subscription.
 */
export interface WebhookSubscription {
  readonly id: string;
  readonly marketId: MarketId;
  readonly merchantId: string;
  readonly url: WebhookUrl;
  readonly eventTypes: readonly WebhookEventType[];
  readonly secretVersion: number;
  /** Until when `secretVersion - 1` still signs too; null when no rotation overlaps. */
  readonly previousSecretValidUntil: Temporal.Instant | null;
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
    previousSecretValidUntil: null,
    status: 'active',
    version: 1,
  };
}

/** Whether a change of this type goes to this subscription. */
export function wants(subscription: WebhookSubscription, type: WebhookEventType): boolean {
  return subscription.status === 'active' && subscription.eventTypes.includes(type);
}

/**
 * The next secret. Calls signed from now on carry the new secret's signature and, until
 * `now + overlapSeconds`, the previous one's as well (both `v1=` entries). A second rotation
 * inside the overlap ends the older secret at once: at most two secrets ever sign.
 */
export function rotateSecret(
  subscription: WebhookSubscription,
  now: Temporal.Instant,
  overlapSeconds: number,
): WebhookSubscription {
  if (subscription.status !== 'active') {
    throw new NotificationsDomainError(
      'webhook-subscription.disabled',
      'A disabled subscription has no secret to rotate',
    );
  }
  if (
    !Number.isInteger(overlapSeconds) ||
    overlapSeconds < 0 ||
    overlapSeconds > MAX_ROTATION_OVERLAP_SECONDS
  ) {
    throw new RangeError('A rotation overlap is 0 to 7 days of whole seconds');
  }
  return {
    ...subscription,
    secretVersion: subscription.secretVersion + 1,
    previousSecretValidUntil: overlapSeconds === 0 ? null : now.add({ seconds: overlapSeconds }),
    version: subscription.version + 1,
  };
}

/** The secret versions a call sent at `now` is signed with: the current one first. */
export function signingSecretVersions(
  subscription: WebhookSubscription,
  now: Temporal.Instant,
): number[] {
  const until = subscription.previousSecretValidUntil;
  const overlapping =
    until !== null && subscription.secretVersion > 1 && Temporal.Instant.compare(now, until) < 0;
  return overlapping
    ? [subscription.secretVersion, subscription.secretVersion - 1]
    : [subscription.secretVersion];
}

/** Changes which delivery events an active subscription receives; the URL never changes. */
export function changeEventTypes(
  subscription: WebhookSubscription,
  eventTypes: readonly WebhookEventType[],
): WebhookSubscription {
  if (subscription.status !== 'active') {
    throw new NotificationsDomainError(
      'webhook-subscription.disabled',
      'A disabled subscription cannot change',
    );
  }
  if (eventTypes.length === 0) {
    throw new NotificationsDomainError(
      'webhook-subscription.no-event-types',
      'A subscription names at least one event type',
    );
  }
  const next = [...new Set(eventTypes)].sort();
  if (next.join() === subscription.eventTypes.join()) return subscription;
  return { ...subscription, eventTypes: next, version: subscription.version + 1 };
}

/** Stops new deliveries; pending ones are dead-lettered when they come due. */
export function disableSubscription(subscription: WebhookSubscription): WebhookSubscription {
  if (subscription.status === 'disabled') return subscription;
  return { ...subscription, status: 'disabled', version: subscription.version + 1 };
}
