import { Temporal } from '@mondapac-drive/shared-kernel';

/**
 * The counters of identity design 6.8, in the closed list of data design 3.5 (a new kind is a
 * migration). Listed in the fixed order in which a unit takes them, so two units never wait on
 * each other in a cycle.
 */
export const THROTTLE_KINDS = [
  'mail.account',
  'mail.origin',
  'second-factor.account',
  'sign-in.account',
  'sign-in.account-origin',
  'sign-in.origin',
  'sign-out-others.account',
] as const;
export type ThrottleKind = (typeof THROTTLE_KINDS)[number];

/** One counter's numbers, from the Market's policy (identity design 6.8). */
export interface ThrottleRule {
  readonly limit: number;
  readonly windowMinutes: number;
  /** 0: no block; the window alone refuses until it ends. */
  readonly blockMinutes: number;
}

/**
 * A counter as the reservation unit left it (data design 3.5): the attempt is already counted.
 * `keyHash` is the keyed hash of what the kind counts; no address or email is ever held.
 */
export interface ThrottleReservation {
  readonly kind: ThrottleKind;
  readonly keyHash: Uint8Array;
  readonly attempts: number;
  readonly windowStartedAt: Temporal.Instant;
  readonly blockedUntil: Temporal.Instant | null;
}

export type ThrottleVerdict =
  { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };

const secondsUntil = (later: Temporal.Instant, now: Temporal.Instant): number =>
  Math.max(1, Math.ceil(now.until(later).total({ unit: 'seconds' })));

/**
 * The verdict on a set of reservations (HF1; data design 3.5): an attempt is refused, without
 * hashing, when any counter is blocked after `now` or holds more attempts than its limit. The
 * refused attempt keeps its count. The announced wait is the longest of the refusing counters:
 * the rest of a block; above the limit, the block that the attempt reaching it is about to set,
 * or for a counter without a block the rest of its window.
 */
export function reservationVerdict(
  reserved: readonly { readonly reservation: ThrottleReservation; readonly rule: ThrottleRule }[],
  now: Temporal.Instant,
): ThrottleVerdict {
  let wait = 0;
  for (const { reservation, rule } of reserved) {
    const { blockedUntil, attempts, windowStartedAt } = reservation;
    if (blockedUntil !== null && Temporal.Instant.compare(blockedUntil, now) > 0) {
      wait = Math.max(wait, secondsUntil(blockedUntil, now));
    } else if (attempts > rule.limit) {
      wait = Math.max(
        wait,
        rule.blockMinutes > 0
          ? rule.blockMinutes * 60
          : secondsUntil(windowStartedAt.add({ minutes: rule.windowMinutes }), now),
      );
    }
  }
  return wait === 0 ? { allowed: true } : { allowed: false, retryAfterSeconds: wait };
}

/**
 * The block a failed attempt sets (data design 3.5): when its reservation reached the limit and
 * the counter blocks, until `now` plus the block; otherwise none.
 */
export function blockAfterFailure(
  reservation: ThrottleReservation,
  rule: ThrottleRule,
  now: Temporal.Instant,
): Temporal.Instant | null {
  return rule.blockMinutes > 0 && reservation.attempts >= rule.limit
    ? now.add({ minutes: rule.blockMinutes })
    : null;
}

/** A window that started at or before this instant has ended and restarts (data design 3.5). */
export function windowRestartBefore(rule: ThrottleRule, now: Temporal.Instant): Temporal.Instant {
  return now.subtract({ minutes: rule.windowMinutes });
}
