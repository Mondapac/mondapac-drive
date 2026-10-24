import type { Temporal } from '@mondapac-drive/shared-kernel';

/**
 * The signature of a Drive webhook (docs/notifications/webhooks.md). The sender computes
 * `HMAC-SHA256(secret, "<timestamp>.<raw body>")` as lowercase hex and sends:
 *
 *   Drive-Timestamp: <unix seconds>
 *   Drive-Signature: v1=<hex>[,v1=<hex>]
 *   Drive-Event-Id:  <event id>       (the receiver's deduplication key)
 *   Drive-Event-Type: <type>
 *
 * A receiver accepts when any `v1` value matches (compared in constant time) and the timestamp
 * is within {@link SIGNATURE_TOLERANCE_SECONDS} of its clock. The crypto lives in
 * infrastructure; these are the rules both sides share.
 */
export const TIMESTAMP_HEADER = 'Drive-Timestamp';
export const SIGNATURE_HEADER = 'Drive-Signature';
export const EVENT_ID_HEADER = 'Drive-Event-Id';
export const EVENT_TYPE_HEADER = 'Drive-Event-Type';
export const SIGNATURE_SCHEME = 'v1';
/** How far a timestamp may be from the receiver's clock, either way: the replay window. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

const HEX_DIGEST = /^[0-9a-f]{64}$/;
const TIMESTAMP = /^[1-9][0-9]{0,11}$/;

/** The timestamp of an attempt: whole Unix seconds. */
export function timestampOf(instant: Temporal.Instant): number {
  return Math.floor(instant.epochMilliseconds / 1000);
}

/** The exact bytes the HMAC covers. */
export function signedContent(timestamp: number, body: string): string {
  if (!Number.isSafeInteger(timestamp) || timestamp < 1) {
    throw new RangeError('A webhook timestamp is positive whole seconds');
  }
  return `${timestamp}.${body}`;
}

/** `v1=<hex>` for each digest, comma separated: more than one while a secret rotates. */
export function signatureHeader(digests: readonly string[]): string {
  if (digests.length === 0 || !digests.every((digest) => HEX_DIGEST.test(digest))) {
    throw new RangeError('A signature is one or more SHA-256 hex digests');
  }
  return digests.map((digest) => `${SIGNATURE_SCHEME}=${digest}`).join(',');
}

/** The `v1` digests of a header; other schemes and malformed parts are ignored. */
export function signatureDigests(header: string): string[] {
  return header
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${SIGNATURE_SCHEME}=`))
    .map((part) => part.slice(SIGNATURE_SCHEME.length + 1))
    .filter((digest) => HEX_DIGEST.test(digest));
}

/** The timestamp header as seconds, or undefined when it is not a plain positive integer. */
export function parseTimestamp(header: string): number | undefined {
  return TIMESTAMP.test(header) ? Number(header) : undefined;
}

/** Whether `timestamp` is inside the replay window around `now`. */
export function isFresh(
  timestamp: number,
  now: Temporal.Instant,
  toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS,
): boolean {
  return Math.abs(timestampOf(now) - timestamp) <= toleranceSeconds;
}
