// The webhook shapes the operations screens read from the notifications admin routes (25b, 33b):
// ids, codes and times only. A call's body and a subscription's secret never reach the panel.

export interface DeadWebhookCall {
  readonly id: string;
  readonly subscriptionId: string;
  /** The merchant the call was for (package 33); older answers lack it. */
  readonly merchantId?: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly status: string;
  readonly attempts: number;
  /** The HTTP status of the last answer, or null when the endpoint never answered. */
  readonly lastStatusCode: number | null;
  /** A transport code (timeout, refused, ...) of the last attempt, or null. */
  readonly lastErrorCode: string | null;
  readonly createdAt: string;
  readonly deadAt: string | null;
  readonly nextAttemptAt: string | null;
}

export interface WebhookSubscription {
  readonly id: string;
  readonly merchantId: string;
  readonly url: string;
  readonly eventTypes: readonly string[];
  readonly status: string;
  readonly secretVersion: number;
  /** While a rotated secret overlaps, the old one is valid until then. */
  readonly previousSecretValidUntil: string | null;
  readonly createdAt: string;
}

export interface SubscriptionPage {
  readonly items: readonly WebhookSubscription[];
  readonly next: string | null;
}

export const WEBHOOK_PERMISSION = {
  /** See dead-lettered calls and send one again (operator seed v5). */
  callResend: 'notifications.webhook-call.resend',
  /** See every merchant's subscriptions (package 33). */
  subscriptionView: 'notifications.webhook-subscription.view',
} as const;
