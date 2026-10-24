import { createHmac, timingSafeEqual } from 'node:crypto';
import { TOTP } from '../../domain/totp';

/**
 * HOTP (RFC 4226 section 5.3) with HMAC-SHA-1: the 8-byte big-endian counter is MACed under the
 * secret, dynamically truncated to 31 bits and reduced to `digits` decimal digits. TOTP (RFC
 * 6238) is HOTP with the time step as the counter. `node:crypto` only (identity design 7.1, 13:
 * the RFC vectors pass with HMAC alone, so no package is needed).
 */
export function hotp(secret: Uint8Array, counter: number, digits: number = TOTP.digits): string {
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw new RangeError('hotp: the counter is a whole number from 0');
  }
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) {
    throw new RangeError('hotp: 6 to 8 digits');
  }
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(message).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  mac.fill(0);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * The first of `steps` at which `code` is the TOTP of `secret`, or null. Every step is computed
 * and compared in constant time, so the time taken does not say which step, if any, matched.
 */
export function matchingStep(
  secret: Uint8Array,
  code: string,
  steps: readonly number[],
): number | null {
  const presented = Buffer.from(code, 'utf8');
  let found: number | null = null;
  for (const step of steps) {
    const expected = Buffer.from(hotp(secret, step), 'utf8');
    const same = expected.length === presented.length && timingSafeEqual(expected, presented);
    if (same && found === null) found = step;
  }
  return found;
}
