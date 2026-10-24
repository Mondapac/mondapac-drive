import type { SmsSender, SmsSendResult } from '../application/ports';
import type { PhoneNumber } from '../domain/sms';
import type { TwilioCredentials } from './notifications-secrets';

/** The longest one SMS request may take. */
export const SMS_TIMEOUT_MS = 10_000;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Sends SMS through Twilio's Messages API. The host is fixed, so no SSRF surface; the number,
 * the text and the token never reach a log or an error code. Twilio's 4xx refusals of a number
 * (21211 invalid, 21610 opted out, 21614 not a mobile) are final; 429 and 5xx are retried.
 */
export class TwilioSmsSender implements SmsSender {
  constructor(
    private readonly credentials: TwilioCredentials,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async send(to: PhoneNumber, from: string, text: string): Promise<SmsSendResult> {
    const { accountSid, authToken } = this.credentials;
    let response: Response;
    try {
      response = await this.fetchImpl(
        `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(SMS_TIMEOUT_MS),
          headers: {
            Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ To: to, From: from, Body: text }).toString(),
        },
      );
    } catch {
      return { ok: false, errorCode: 'sms.network', retryable: true };
    }
    const answer = (await response.json().catch(() => ({}))) as { sid?: unknown; code?: unknown };
    if (response.ok && typeof answer.sid === 'string' && /^SM[0-9a-f]{32}$/.test(answer.sid)) {
      return { ok: true, providerMessageId: answer.sid };
    }
    const retryable = response.status === 429 || response.status >= 500;
    const code = typeof answer.code === 'number' ? `.${answer.code}` : '';
    return { ok: false, errorCode: `sms.twilio-${response.status}${code}`, retryable };
  }
}

/** The sender while Twilio is not configured: every attempt fails and is retried, then dies. */
export class UnconfiguredSmsSender implements SmsSender {
  send(): Promise<SmsSendResult> {
    return Promise.resolve({ ok: false, errorCode: 'sms.not-configured', retryable: true });
  }
}
