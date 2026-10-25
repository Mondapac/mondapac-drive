import { createHmac } from 'node:crypto';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIOD_SECONDS = 30;
const DIGITS = 6;

/**
 * The code an authenticator app shows for a base32 secret at `epochMilliseconds` (RFC 6238:
 * HMAC-SHA-1, six digits, 30-second steps). The dev seed types it as an admin would; identity
 * keeps its own implementation, which this one never imports (identity imports nothing and
 * nothing imports identity's internals).
 */
export function totpCode(secret: string, epochMilliseconds: number): string {
  const key = decodeBase32(secret);
  const counter = Math.floor(epochMilliseconds / 1000 / PERIOD_SECONDS);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', key).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** RFC 4648 base32, padding and case ignored. */
export function decodeBase32(text: string): Buffer {
  const clean = text.toUpperCase().replace(/=+$/, '');
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of clean) {
    const value = BASE32.indexOf(character);
    if (value === -1) throw new Error('decodeBase32: not a base32 secret');
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}
