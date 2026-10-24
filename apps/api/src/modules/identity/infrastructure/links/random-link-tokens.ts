import { createHash, randomBytes } from 'node:crypto';
import type { IssuedLinkToken, LinkTokens } from '../../application/ports/link-secrets';

/** The version prefix of a link token, so scanners and log filters recognise one (6.2, 6.6). */
export const LINK_TOKEN_PREFIX = 'ml1_';
const TOKEN_BYTES = 32;
const TOKEN = /^ml1_[A-Za-z0-9_-]{43}$/;

/**
 * {@link LinkTokens} (identity design 6.6): the shape of a session token (6.2) with its own
 * prefix: 32 bytes from the system random source, base64url. Only the SHA-256 of the whole
 * token is stored; 256 bits of entropy make an unkeyed fast hash enough (Hassan, 14.2).
 */
export class RandomLinkTokens implements LinkTokens {
  issue(): IssuedLinkToken {
    const token = `${LINK_TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
    return { token, tokenHash: sha256(token) };
  }

  hashOf(token: string): Uint8Array | null {
    return TOKEN.test(token) ? sha256(token) : null;
  }
}

const sha256 = (token: string): Uint8Array =>
  new Uint8Array(createHash('sha256').update(token, 'utf8').digest());
