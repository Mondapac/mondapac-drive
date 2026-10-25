import { Temporal } from '@mondapac-drive/shared-kernel';
import { NotificationsDomainError } from './errors';

/** The phone platforms a courier's push device runs on. */
export const PUSH_PLATFORMS = ['ios', 'android'] as const;
export type PushPlatform = (typeof PUSH_PLATFORMS)[number];

/** An Expo push token, as the courier app's `getExpoPushTokenAsync` answers it. */
export type ExpoPushToken = string & { readonly __brand: 'ExpoPushToken' };

/**
 * `ExponentPushToken[...]` (or the newer `ExpoPushToken[...]`) with a base64url-like id. The
 * token addresses one phone: it is sealed at rest, never logged and never answered.
 */
const EXPO_PUSH_TOKEN = /^Expo(?:nent)?PushToken\[[A-Za-z0-9_-]{16,128}\]$/;

/** The token, or undefined when it is not an Expo push token. */
export function parseExpoPushToken(raw: string): ExpoPushToken | undefined {
  return EXPO_PUSH_TOKEN.test(raw) ? (raw as ExpoPushToken) : undefined;
}

/**
 * The push device of one courier session. A session has at most one; a token belongs to at
 * most one session (the newest to register it). The device lives no longer than the session can
 * (`expiresAt`: registration plus the courier session's absolute lifetime), and is dropped
 * earlier on sign-out and when identity ends the account's sessions.
 */
export interface PushDevice {
  readonly id: string;
  readonly accountId: string;
  readonly sessionId: string;
  readonly platform: PushPlatform;
  readonly token: ExpoPushToken;
  readonly registeredAt: Temporal.Instant;
  readonly expiresAt: Temporal.Instant;
}

export interface NewPushDevice {
  readonly id: string;
  readonly accountId: string;
  readonly sessionId: string;
  readonly platform: PushPlatform;
  readonly token: ExpoPushToken;
}

/** A device registered now, for a session that lives at most `lifetimeSeconds` from now. */
export function registerPushDevice(
  device: NewPushDevice,
  now: Temporal.Instant,
  lifetimeSeconds: number,
): PushDevice {
  if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 1) {
    throw new NotificationsDomainError(
      'push-device.lifetime',
      'A device lives at least one second',
    );
  }
  return { ...device, registeredAt: now, expiresAt: now.add({ seconds: lifetimeSeconds }) };
}

/** Whether a device may still receive a push at `now`. */
export function isLivePushDevice(device: PushDevice, now: Temporal.Instant): boolean {
  return Temporal.Instant.compare(now, device.expiresAt) < 0;
}

/** The Market's offer push wording: `body` names `{seconds}` once. */
export interface OfferPushText {
  readonly title: string;
  readonly body: string;
}

/** One push of a new offer: no address, recipient or merchant; the offer id only. */
export interface OfferPush {
  readonly title: string;
  readonly body: string;
  readonly data: { readonly kind: 'offer'; readonly offerId: string };
  /** How long the push service may hold it: never past the offer's expiry. */
  readonly ttlSeconds: number;
}

/**
 * The push of an offer that expires at `expiresAt`, or undefined when less than a second is
 * left (an expired offer is not pushed).
 */
export function offerPush(
  text: OfferPushText,
  offerId: string,
  expiresAt: Temporal.Instant,
  now: Temporal.Instant,
): OfferPush | undefined {
  const seconds = Math.floor(Number(expiresAt.epochNanoseconds - now.epochNanoseconds) / 1e9);
  if (seconds < 1) return undefined;
  return {
    title: text.title,
    body: text.body.replace('{seconds}', String(seconds)),
    data: { kind: 'offer', offerId },
    ttlSeconds: seconds,
  };
}
