import type { PushSender, PushTicket } from '../application/ports';
import type { ExpoPushToken, OfferPush } from '../domain/push-device';
import type { FetchLike } from './twilio-sms-sender';

/** Expo's push API (https://docs.expo.dev/push-notifications/sending-notifications/). */
export const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
/** The longest one push request may take. */
export const PUSH_TIMEOUT_MS = 10_000;
/** Expo takes at most 100 messages per request. */
export const EXPO_BATCH = 100;

const retryableFailure = (errorCode: string): PushTicket => ({
  ok: false,
  errorCode,
  retryable: true,
  deviceGone: false,
});

/** One ticket as Expo answers it; anything else is a failure that may pass. */
function ticketOf(raw: unknown): PushTicket {
  if (typeof raw !== 'object' || raw === null) return retryableFailure('push.expo-malformed');
  const { status, details } = raw as { status?: unknown; details?: { error?: unknown } };
  if (status === 'ok') return { ok: true };
  const error = typeof details?.error === 'string' ? details.error : 'unknown';
  const code = /^[A-Za-z]{1,40}$/.test(error) ? error : 'unknown';
  return {
    ok: false,
    errorCode: `push.${code}`,
    retryable: code === 'MessageRateExceeded' || code === 'unknown',
    deviceGone: code === 'DeviceNotRegistered',
  };
}

/**
 * Sends pushes through Expo's push service, with `EXPO_ACCESS_TOKEN` when the project enforces
 * push security. The host is fixed, so there is no SSRF surface; a token or the text never
 * reaches a log or an error code. A ticket of `DeviceNotRegistered` drops the device; 429, 5xx,
 * a network failure and `MessageRateExceeded` may pass and are retried through the inbox. The
 * push expires with the offer (`ttl`) and is sent at high priority.
 */
export class ExpoPushSender implements PushSender {
  constructor(
    private readonly accessToken: string | null,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async send(to: readonly ExpoPushToken[], push: OfferPush): Promise<PushTicket[]> {
    const tickets: PushTicket[] = [];
    for (let start = 0; start < to.length; start += EXPO_BATCH) {
      tickets.push(...(await this.batch(to.slice(start, start + EXPO_BATCH), push)));
    }
    return tickets;
  }

  private async batch(to: readonly ExpoPushToken[], push: OfferPush): Promise<PushTicket[]> {
    const messages = to.map((token) => ({
      to: token,
      title: push.title,
      body: push.body,
      data: push.data,
      ttl: push.ttlSeconds,
      priority: 'high',
      sound: 'default',
    }));
    let response: Response;
    try {
      response = await this.fetchImpl(EXPO_PUSH_URL, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(this.accessToken === null ? {} : { Authorization: `Bearer ${this.accessToken}` }),
        },
        body: JSON.stringify(messages),
      });
    } catch {
      return to.map(() => retryableFailure('push.network'));
    }
    const answer = (await response.json().catch(() => ({}))) as { data?: unknown };
    if (!response.ok || !Array.isArray(answer.data) || answer.data.length !== to.length) {
      const retryable = !response.ok ? response.status === 429 || response.status >= 500 : true;
      return to.map(() => ({
        ok: false as const,
        errorCode: `push.expo-${response.status}`,
        retryable,
        deviceGone: false,
      }));
    }
    return answer.data.map(ticketOf);
  }
}

/** The sender while push is turned off: every push fails and is not retried. */
export class DisabledPushSender implements PushSender {
  send(to: readonly ExpoPushToken[]): Promise<PushTicket[]> {
    return Promise.resolve(
      to.map(() => ({
        ok: false as const,
        errorCode: 'push.disabled',
        retryable: false,
        deviceGone: false,
      })),
    );
  }
}
