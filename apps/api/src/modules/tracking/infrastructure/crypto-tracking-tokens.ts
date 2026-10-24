import { createHash, randomBytes } from 'node:crypto';
import type { TrackingTokens } from '../application/ports';

/** 32 random bytes, base64url without padding: 43 characters, 256 bits. */
const TOKEN_BYTES = 32;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

const sha256 = (token: string): string => createHash('sha256').update(token).digest('hex');

/**
 * Tracking-link tokens from the operating system's CSPRNG. Only the SHA-256 of a token is
 * stored: a token has 256 bits of entropy, so an unsalted hash cannot be reversed, and a leaked
 * table gives no working link.
 */
export class CryptoTrackingTokens implements TrackingTokens {
  issue(): { token: string; hash: string } {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    return { token, hash: sha256(token) };
  }

  hashOf(token: string): string | undefined {
    return TOKEN_SHAPE.test(token) ? sha256(token) : undefined;
  }
}
