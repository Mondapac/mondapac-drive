/**
 * The mail transport of identity design 9 (decided by Ali, 14.1-5): a port and its adapters
 * only, in `platform/mail/`. A message arrives fully rendered; the transport knows no template,
 * no locale and no business rule. `sellers` will use the same port before `notifications`
 * exists (Phase 6).
 *
 * A message holds personal data (the address) and, for a link mail, a one-time token in its
 * body. Neither is ever logged, put in an error or an event: an adapter's error carries a
 * fixed code only (platform persistence 12.3; identity design 6.6, AC 12).
 */
export interface MailMessage {
  /** The one recipient's address. */
  readonly to: string;
  /** The sender, from the Market's configuration. */
  readonly from: { readonly address: string; readonly name: string };
  readonly subject: string;
  /** Plain text only: no HTML is ever sent, so nothing user-supplied can become markup (HF13). */
  readonly text: string;
  /**
   * The one-click unsubscribe URL of a marketing mail (https, RFC 8058): sent as the
   * `List-Unsubscribe` header with `List-Unsubscribe-Post: List-Unsubscribe=One-Click`. Absent on
   * every other mail. It holds a signed token; never logged.
   */
  readonly listUnsubscribe?: string;
}

/** Why a send failed: a code, never a server message or a value. */
export type MailSendFailure =
  | 'mail.transport-unconfigured'
  | 'mail.transport-unreachable'
  | 'mail.transport-timeout'
  | 'mail.transport-refused';

/** A failed send. The event dispatcher retries the delivery after its back-off (P 6.4). */
export class MailSendError extends Error {
  override readonly name = 'MailSendError';
  constructor(readonly code: MailSendFailure) {
    super(`The mail was not sent: ${code}`);
  }
}

export interface MailTransport {
  /**
   * Resolves when the transport accepted the message; throws {@link MailSendError} otherwise.
   *
   * An adapter ends a request on its own timeout, at most 5 seconds: the reviewer notice
   * (identity design 8.7) stops waiting for a send after `REVIEWER_NOTICE_SEND_TIMEOUT_MS` (5 s)
   * and cannot cancel it, so a longer adapter timeout would leave a send running after the call
   * returned (Hassan I-3). The Mailpit adapter's `MAIL_SEND_TIMEOUT_MS` is 5 s.
   */
  send(message: MailMessage): Promise<void>;
}

/** Nest token of the {@link MailTransport}. */
export const MAIL_TRANSPORT = Symbol('MAIL_TRANSPORT');
