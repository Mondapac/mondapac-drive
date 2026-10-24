import { MailSendError, type MailMessage, type MailTransport } from './mail-transport';

/** How long one send may take before it counts as failed. */
export const MAIL_SEND_TIMEOUT_MS = 5000;

/** `fetch`, narrowed to what the adapter uses, so tests can pass a fake. */
export type Fetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ readonly ok: boolean; readonly status: number }>;

/**
 * The Phase 2 adapter of {@link MailTransport}: the local mail catcher of the Compose file
 * (Mailpit), through its HTTP send interface `POST /api/v1/send` (identity design 9 and spike 4,
 * 2026-10-07: Mailpit v1.27.11 accepts a mail through `fetch`, so no SMTP client and no package
 * is needed). A local stand-in: `MailModule` builds it only when `MAIL_CATCHER_URL` is set and
 * `NODE_ENV` is explicitly `development` or `test`, so a production start never sends real
 * addresses to a catcher. The deployed provider's adapter comes with the first environment.
 *
 * Errors carry a code only: never the address, the body (a link token) or Mailpit's answer.
 */
export class MailpitHttpTransport implements MailTransport {
  readonly #endpoint: string;

  constructor(
    baseUrl: string,
    private readonly fetchFn: Fetch = (url, init) => fetch(url, init),
    private readonly timeoutMs: number = MAIL_SEND_TIMEOUT_MS,
  ) {
    this.#endpoint = new URL('/api/v1/send', baseUrl).toString();
  }

  async send(message: MailMessage): Promise<void> {
    const body = JSON.stringify({
      From: { Email: message.from.address, Name: message.from.name },
      To: [{ Email: message.to }],
      Subject: message.subject,
      Text: message.text,
      ...(message.listUnsubscribe === undefined
        ? {}
        : {
            Headers: {
              'List-Unsubscribe': `<${message.listUnsubscribe}>`,
              'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
            },
          }),
    });
    let response: { readonly ok: boolean };
    try {
      response = await this.fetchFn(this.#endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timedOut =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new MailSendError(timedOut ? 'mail.transport-timeout' : 'mail.transport-unreachable');
    }
    if (!response.ok) throw new MailSendError('mail.transport-refused');
  }
}

/**
 * The transport when none is configured (`MAIL_CATCHER_URL` unset): every send fails, so the
 * delivery is retried and, after its last attempt, dead-lettered with an alert (P 6.4). Nothing
 * is lost silently and the API still starts, for the HTTP suites and a stack without mail.
 */
export class UnconfiguredMailTransport implements MailTransport {
  send(): Promise<void> {
    return Promise.reject(new MailSendError('mail.transport-unconfigured'));
  }
}
