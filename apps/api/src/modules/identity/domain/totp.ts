import type { Temporal } from '@mondapac-drive/shared-kernel';

/**
 * Hassan's TOTP parameters (identity design 7.1; RFC 6238), which every common authenticator
 * app accepts: HMAC-SHA-1, six digits, 30-second steps counted from the Unix epoch, one step of
 * tolerance each way, and a 160-bit secret. Security parameters, not Market policy: a code that
 * an app cannot produce is no code at all, so they are fixed here and never configured.
 */
export const TOTP = Object.freeze({
  algorithm: 'SHA1',
  digits: 6,
  periodSeconds: 30,
  /** Steps accepted on either side of the current one (clock drift, a code typed late). */
  toleranceSteps: 1,
  /** 20 bytes = 160 bits (identity design 7.5). */
  secretBytes: 20,
} as const);

/** Exactly six ASCII digits; anything else is not a code and is refused before any secret is read. */
const CODE = /^[0-9]{6}$/;

/**
 * A code as typed, if it has the shape of one: surrounding spaces and one inner space or hyphen
 * (apps show "123 456") are dropped, nothing else is forgiven. Null when it is not six digits.
 */
export function parseTotpCode(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 16) return null;
  const compact = raw.trim().replace(/^([0-9]{3})[ -]([0-9]{3})$/, '$1$2');
  return CODE.test(compact) ? compact : null;
}

/** The RFC 6238 time step that contains `at` (T = floor((t - T0) / X), T0 = 0, X = 30 s). */
export function timeStepAt(at: Temporal.Instant): number {
  const seconds = Math.floor(at.epochMilliseconds / 1000);
  return Math.floor(seconds / TOTP.periodSeconds);
}

/**
 * The steps a code typed at `at` may belong to, the current one first, then the one before and
 * the one after (identity design 7.1: one step of tolerance each way). Steps are never negative.
 */
export function candidateSteps(at: Temporal.Instant): readonly number[] {
  const current = timeStepAt(at);
  const steps = [current];
  for (let k = 1; k <= TOTP.toleranceSteps; k += 1) steps.push(current - k, current + k);
  return Object.freeze(steps.filter((step) => step >= 0));
}

/**
 * Whether `step` may still be accepted after `lastAcceptedStep` (identity design 7.1, data
 * design 3.10): a step is accepted once, and never one at or before the last accepted step, so
 * a code seen over a shoulder cannot be replayed, not even inside its own 90-second window. The
 * repository's guarded update (`last_accepted_step < $step`) is the guarantee under concurrency;
 * this is the same rule in memory.
 */
export function stepIsFresh(step: number, lastAcceptedStep: number | null): boolean {
  return (
    Number.isSafeInteger(step) &&
    step >= 0 &&
    (lastAcceptedStep === null || step > lastAcceptedStep)
  );
}
