import type { CallContext, MarketContext, MarketId, Temporal } from '@mondapac-drive/shared-kernel';
import type { SmsKind, WebhookEventType } from '../domain/delivery-change';
import type { OutboundMessage, RetryPolicy } from '../domain/outbound-message';
import type { PhoneNumber, SmsSettings } from '../domain/sms';
import type { WebhookSubscription } from '../domain/webhook-subscription';
import type { WebhookUrl } from '../domain/webhook-url';

/** The notification rules of a hosted Market (`notifications` section of its Market file). */
export interface NotificationSettings {
  readonly webhookRetry: RetryPolicy;
  /** How long a rotated-out secret still signs next to the new one. */
  readonly rotationOverlapSeconds: number;
  readonly sms: SmsSettings;
}
export interface NotificationSettingsProvider {
  get(marketId: MarketId): NotificationSettings;
}
export const NOTIFICATION_SETTINGS = Symbol('NotificationSettingsProvider');

/**
 * Merchant webhook subscriptions of one Market. Every method runs inside the caller's unit of
 * work; writes in a read-write one.
 */
export interface WebhookSubscriptionRepository {
  findById(market: MarketContext, id: string): Promise<WebhookSubscription | undefined>;
  /** The active subscriptions of a merchant, oldest first. */
  activeOf(market: MarketContext, merchantId: string): Promise<WebhookSubscription[]>;
  /** Every subscription of a merchant, active and disabled, newest first, at most `limit`. */
  listOf(market: MarketContext, merchantId: string, limit: number): Promise<WebhookSubscription[]>;
  insert(market: MarketContext, subscription: WebhookSubscription): Promise<void>;
  /** Saves version n + 1 over n; throws `StaleAggregateError` when the stored one is not n. */
  update(market: MarketContext, subscription: WebhookSubscription): Promise<void>;
}
export const WEBHOOK_SUBSCRIPTIONS = Symbol('WebhookSubscriptionRepository');

/** One call of one change to one subscription. The body is fixed when the call is queued. */
export interface WebhookCall extends OutboundMessage {
  readonly id: string;
  readonly subscriptionId: string;
  readonly eventId: string;
  readonly eventType: WebhookEventType;
  /** The JSON body, byte for byte what every attempt sends. Holds no personal data. */
  readonly body: string;
  /** The HTTP status of the last answer, when there was one. */
  readonly lastStatusCode: number | null;
  readonly createdAt: Temporal.Instant;
}

/** One recipient SMS of one delivery. The number is looked up at each attempt, never stored. */
export interface SmsMessage extends OutboundMessage {
  readonly id: string;
  readonly deliveryId: string;
  readonly kind: SmsKind;
  readonly eventId: string;
  /** The merchant's order reference, for the template. */
  readonly reference: string;
  readonly providerMessageId: string | null;
  readonly createdAt: Temporal.Instant;
}

/**
 * Queued outbound messages of one Market: webhook calls and SMS. `insert` skips a duplicate
 * (the same change for the same subscription, or the same SMS kind for the same delivery) and
 * answers how many it wrote. `save` writes the delivery state of a message whose stored
 * `attempts` is `expectedAttempts`, and answers false, writing nothing, when another pass
 * moved it since.
 */
export interface OutboundRepository {
  insertCalls(market: MarketContext, calls: readonly WebhookCall[]): Promise<number>;
  insertSms(market: MarketContext, message: SmsMessage): Promise<number>;
  dueCalls(market: MarketContext, now: Temporal.Instant, limit: number): Promise<WebhookCall[]>;
  dueSms(market: MarketContext, now: Temporal.Instant, limit: number): Promise<SmsMessage[]>;
  findCall(market: MarketContext, id: string): Promise<WebhookCall | undefined>;
  /** Dead-lettered calls, the most recently dead first, at most `limit`. */
  deadCalls(market: MarketContext, limit: number): Promise<WebhookCall[]>;
  saveCall(market: MarketContext, call: WebhookCall, expectedAttempts: number): Promise<boolean>;
  saveSms(market: MarketContext, message: SmsMessage, expectedAttempts: number): Promise<boolean>;
}
export const OUTBOUND_REPOSITORY = Symbol('OutboundRepository');

/** The HTTP outcome of one webhook attempt. Never throws for a network failure. */
export type WebhookResponse =
  | { readonly ok: true; readonly statusCode: number }
  | {
      readonly ok: false;
      /** `http.<status>`, `webhook.timeout`, `webhook.network`, `webhook-url.private-host`, ... */
      readonly errorCode: string;
      readonly statusCode: number | null;
      readonly retryable: boolean;
    };

/** Posts a signed body to a merchant's endpoint, refusing any address that is not public. */
export interface WebhookTransport {
  post(
    url: WebhookUrl,
    headers: Readonly<Record<string, string>>,
    body: string,
  ): Promise<WebhookResponse>;
}
export const WEBHOOK_TRANSPORT = Symbol('WebhookTransport');

/** Computes the HMAC-SHA256 of signed content with a subscription's derived secret. */
export interface WebhookSigner {
  /** The hex digest of `content` under the secret of (subscription, version). */
  sign(subscriptionId: string, secretVersion: number, content: string): string;
  /** The secret itself, shown to the merchant once, when it is created or rotated. */
  secretFor(subscriptionId: string, secretVersion: number): string;
}
export const WEBHOOK_SIGNER = Symbol('WebhookSigner');

/** The outcome of one SMS attempt. Never throws for a provider failure. */
export type SmsSendResult =
  | { readonly ok: true; readonly providerMessageId: string }
  | { readonly ok: false; readonly errorCode: string; readonly retryable: boolean };

/** Sends one SMS. Implementations never log the number or the text. */
export interface SmsSender {
  send(to: PhoneNumber, from: string, text: string): Promise<SmsSendResult>;
}
export const SMS_SENDER = Symbol('SmsSender');

/**
 * What notifications may know of a delivery, read from the delivery module with the Market's
 * system context (`DeliveryRecipients.forNotification`). The phone and the PIN are personal
 * data: they are handed to the SMS sender at the attempt and never stored, logged or put in an
 * error.
 */
export interface DeliveryContact {
  readonly merchantId: string;
  readonly externalReference: string;
  readonly dropoffPhone: string | null;
  readonly recipientPin: string | null;
}

/**
 * The delivery module's read for notifications. Undefined when the delivery is unknown.
 * `referenceOf` answers the merchant side only, for queueing a change; `contactOf` the
 * recipient's phone and PIN too, for an SMS attempt only.
 */
export interface DeliveryContacts {
  referenceOf(
    context: CallContext,
    deliveryId: string,
  ): Promise<Pick<DeliveryContact, 'merchantId' | 'externalReference'> | undefined>;
  contactOf(context: CallContext, deliveryId: string): Promise<DeliveryContact | undefined>;
}
export const DELIVERY_CONTACTS = Symbol('DeliveryContacts');

/**
 * Issues a customer tracking link for a delivery (tracking's `IssueTrackingLink`), answering its
 * token, shown once; undefined while tracking cannot issue one (not tracked yet, or ended).
 */
export interface TrackingLinks {
  issue(context: CallContext, deliveryId: string): Promise<string | undefined>;
}
export const TRACKING_LINKS = Symbol('TrackingLinks');
