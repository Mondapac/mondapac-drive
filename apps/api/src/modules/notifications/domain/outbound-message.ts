import { Temporal } from '@mondapac-drive/shared-kernel';
import { NotificationsDomainError } from './errors';

/**
 * The retry rules of one Market for one channel (`notifications` section of its Market file).
 * `firstRetrySeconds` is the wait after the first failed attempt; each further failure doubles
 * it, up to `maxRetrySeconds`. After `maxAttempts` attempts the message is dead.
 */
export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly firstRetrySeconds: number;
  readonly maxRetrySeconds: number;
}

/** How long a claimed message stays claimed: longer than one send may take (timeout 10 s). */
export const CLAIM_LEASE_SECONDS = 60;

/** The wait after the `failedAttempts`-th failed attempt (1, 2, ...). */
export function retryDelaySeconds(policy: RetryPolicy, failedAttempts: number): number {
  if (!Number.isInteger(failedAttempts) || failedAttempts < 1) {
    throw new RangeError('failedAttempts starts at 1');
  }
  const doublings = Math.min(failedAttempts - 1, 30);
  return Math.min(policy.firstRetrySeconds * 2 ** doublings, policy.maxRetrySeconds);
}

export type MessageStatus = 'pending' | 'sent' | 'dead';

/**
 * The delivery state of one outbound message: a webhook call or an SMS. `attempts` counts the
 * claims; a claim is an attempt even when the process dies before it records the outcome.
 */
export interface OutboundMessage {
  readonly status: MessageStatus;
  readonly attempts: number;
  /** When a pending message is due; null once it is sent or dead. */
  readonly nextAttemptAt: Temporal.Instant | null;
  readonly lastErrorCode: string | null;
  readonly sentAt: Temporal.Instant | null;
  readonly deadAt: Temporal.Instant | null;
}

/** A new message, due at once. */
export function newOutboundMessage(now: Temporal.Instant): OutboundMessage {
  return {
    status: 'pending',
    attempts: 0,
    nextAttemptAt: now,
    lastErrorCode: null,
    sentAt: null,
    deadAt: null,
  };
}

export function isDue(message: OutboundMessage, now: Temporal.Instant): boolean {
  return (
    message.status === 'pending' &&
    message.nextAttemptAt !== null &&
    Temporal.Instant.compare(message.nextAttemptAt, now) <= 0
  );
}

/**
 * Takes a due message for one attempt: counts it and hides it for the lease, so that a second
 * worker pass does not send it again while this one runs.
 */
export function claim(message: OutboundMessage, now: Temporal.Instant): OutboundMessage {
  if (!isDue(message, now)) {
    throw new NotificationsDomainError('notifications.not-due', 'The message is not due');
  }
  return {
    ...message,
    attempts: message.attempts + 1,
    nextAttemptAt: now.add({ seconds: CLAIM_LEASE_SECONDS }),
  };
}

/**
 * Whether a due message has used all its attempts: a claim whose outcome was never recorded
 * (the process died, or recording failed) still counts, so such a message is dead-lettered
 * instead of being claimed again without end.
 */
export function isExhausted(message: OutboundMessage, policy: RetryPolicy): boolean {
  return message.status === 'pending' && message.attempts >= policy.maxAttempts;
}

/** Dead-letters a message whose attempts ran out without a recorded outcome. */
export function exhaust(message: OutboundMessage, now: Temporal.Instant): OutboundMessage {
  if (message.status !== 'pending') {
    throw new NotificationsDomainError('notifications.not-pending', 'The message is not pending');
  }
  return {
    ...message,
    status: 'dead',
    nextAttemptAt: null,
    lastErrorCode: message.lastErrorCode ?? 'notifications.attempts-exhausted',
    deadAt: now,
  };
}

/** What one attempt achieved. `retryable: false` dead-letters at once (a refused URL, a bad number). */
export type AttemptOutcome =
  | { readonly sent: true }
  | { readonly sent: false; readonly errorCode: string; readonly retryable: boolean };

/** Records the outcome of the attempt the last {@link claim} counted. */
export function recordAttempt(
  message: OutboundMessage,
  outcome: AttemptOutcome,
  now: Temporal.Instant,
  policy: RetryPolicy,
): OutboundMessage {
  if (message.status !== 'pending' || message.attempts < 1) {
    throw new NotificationsDomainError('notifications.not-claimed', 'The message is not claimed');
  }
  if (outcome.sent) {
    return { ...message, status: 'sent', nextAttemptAt: null, lastErrorCode: null, sentAt: now };
  }
  if (!outcome.retryable || message.attempts >= policy.maxAttempts) {
    return {
      ...message,
      status: 'dead',
      nextAttemptAt: null,
      lastErrorCode: outcome.errorCode,
      deadAt: now,
    };
  }
  return {
    ...message,
    nextAttemptAt: now.add({ seconds: retryDelaySeconds(policy, message.attempts) }),
    lastErrorCode: outcome.errorCode,
  };
}

/**
 * An operator sends a dead message again: it is due at once with a fresh count of attempts.
 * Only a dead message can be sent again; a sent one is never repeated by this path.
 */
export function resend(message: OutboundMessage, now: Temporal.Instant): OutboundMessage {
  if (message.status !== 'dead') {
    throw new NotificationsDomainError(
      'notifications.not-dead',
      'Only a dead-lettered message can be sent again',
    );
  }
  return { ...message, status: 'pending', attempts: 0, nextAttemptAt: now, deadAt: null };
}
