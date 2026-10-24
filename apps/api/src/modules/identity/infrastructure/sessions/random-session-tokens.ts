import { createHash, randomBytes } from 'node:crypto';
import type { IssuedSessionToken, SessionTokens } from '../../application/ports/session-secrets';

/** The version prefix of a session token, so scanners and log filters recognise one (6.2). */
export const SESSION_TOKEN_PREFIX = 'ms1_';
const TOKEN_BYTES = 32;
const TOKEN = /^ms1_[A-Za-z0-9_-]{43}$/;

/**
 * {@link SessionTokens} (identity design 6.2): 32 bytes from the system random source,
 * base64url, with the prefix `ms1_`. Only the SHA-256 of the whole token is stored; the token
 * has 256 bits of entropy, so an unkeyed fast hash is enough (Hassan, 14.2).
 */
export class RandomSessionTokens implements SessionTokens {
  issue(): IssuedSessionToken {
    const token = `${SESSION_TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
    return { token, tokenHash: sha256(token) };
  }

  hashOf(token: string): Uint8Array | null {
    return TOKEN.test(token) ? sha256(token) : null;
  }
}

const sha256 = (token: string): Uint8Array =>
  new Uint8Array(createHash('sha256').update(token, 'utf8').digest());
