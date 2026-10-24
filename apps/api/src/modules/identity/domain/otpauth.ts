import { TOTP } from './totp';

/** RFC 4648 base32: the alphabet authenticator apps expect for a typed secret. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** A secret as RFC 4648 base32 without padding (20 bytes are 32 characters). */
export function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Reads a TOTP secret back from base32 (identity design 3.4: the secret an admin's acceptance
 * returned, presented again with its tag): case and spaces are forgiven; anything that is not
 * exactly {@link TOTP.secretBytes} bytes of the alphabet, padding included, is null.
 */
export function decodeBase32Secret(raw: unknown): Uint8Array | null {
  if (typeof raw !== 'string' || raw.length > 64) return null;
  const text = raw.replace(/\s/g, '').toUpperCase();
  if (text.length !== Math.ceil((TOTP.secretBytes * 8) / 5)) return null;
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of text) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) return null;
    value = ((value << 5) | index) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return bytes.length === TOTP.secretBytes ? Uint8Array.from(bytes) : null;
}

/**
 * The `otpauth://totp/` URI of a new secret (identity design 7.1): the panel draws it as a QR
 * code itself, never through a remote service (13). The issuer is the Market's mail sender name
 * and the account name the sign-in address, both escaped; the parameters are the fixed ones of
 * {@link TOTP}. Returned only to the person enrolling, never logged.
 */
export function otpauthUri(input: {
  readonly issuer: string;
  readonly accountName: string;
  readonly secret: Uint8Array;
}): string {
  const issuer = encodeURIComponent(input.issuer);
  const account = encodeURIComponent(input.accountName);
  const query = new URLSearchParams({
    secret: encodeBase32(input.secret),
    issuer: input.issuer,
    algorithm: TOTP.algorithm,
    digits: String(TOTP.digits),
    period: String(TOTP.periodSeconds),
  });
  return `otpauth://totp/${issuer}:${account}?${query.toString()}`;
}
