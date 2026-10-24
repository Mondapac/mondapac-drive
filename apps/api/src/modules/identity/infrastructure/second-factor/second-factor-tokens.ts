import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Id, MarketContext, Temporal } from '@mondapac-drive/shared-kernel';
import type { IssuedLinkToken } from '../../application/ports/link-secrets';
import type {
  EnrolmentSecretTags,
  OpaqueTokens,
} from '../../application/ports/second-factor-tokens';

/** The prefix of a challenge token (`mc1_`) and of an invitation token (`mi1_`). */
export const CHALLENGE_TOKEN_PREFIX = 'mc1_';
export const INVITATION_TOKEN_PREFIX = 'mi1_';
const TOKEN_BYTES = 32;

/**
 * {@link OpaqueTokens} with a prefix (identity design 6.2, 6.6): 32 bytes from the system random
 * source, base64url. Only the SHA-256 of the whole token is stored; 256 bits of entropy make an
 * unkeyed fast hash enough (Hassan, 14.2).
 */
export class RandomPrefixedTokens implements OpaqueTokens {
  readonly #shape: RegExp;

  constructor(private readonly prefix: string) {
    if (!/^m[a-z][0-9]_$/.test(prefix)) throw new TypeError('A token prefix reads like "mc1_"');
    this.#shape = new RegExp(`^${prefix}[A-Za-z0-9_-]{43}$`);
  }

  issue(): IssuedLinkToken {
    const token = `${this.prefix}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
    return { token, tokenHash: sha256(token) };
  }

  hashOf(token: string): Uint8Array | null {
    return this.#shape.test(token) ? sha256(token) : null;
  }
}

const sha256 = (token: string): Uint8Array =>
  new Uint8Array(createHash('sha256').update(token, 'utf8').digest());

/** The label that derives the tag key from the stack secret (identity design 3.4: its own label). */
const TAG_LABEL = 'mondapac.identity.enrolment-secret-tag.v1';
const TAG = /^[A-Za-z0-9_-]{43}$/;

/**
 * {@link EnrolmentSecretTags} (identity design 3.4, HF6): HMAC-SHA-256 under a key derived from
 * the stack secret of 6.8 (the throttle secret) with its own label, over the Market, the
 * invitation id, the secret and the expiry, encoded as a JSON array so no two inputs share a
 * message. Compared in constant time. The key and the secret are never logged.
 */
export class HmacEnrolmentSecretTags implements EnrolmentSecretTags {
  readonly #key: Buffer;

  constructor(stackSecret: Uint8Array) {
    if (stackSecret.length !== 32) throw new TypeError('The stack secret is 32 bytes');
    this.#key = createHmac('sha256', stackSecret).update(TAG_LABEL).digest();
  }

  tag(
    market: MarketContext,
    invitationId: Id<'Invitation'>,
    secret: Uint8Array,
    expiresAt: Temporal.Instant,
  ): string {
    return this.mac(market, invitationId, secret, expiresAt).toString('base64url');
  }

  matches(
    market: MarketContext,
    invitationId: Id<'Invitation'>,
    secret: Uint8Array,
    expiresAt: Temporal.Instant,
    tag: string,
  ): boolean {
    if (!TAG.test(tag)) return false;
    const presented = Buffer.from(tag, 'base64url');
    const expected = this.mac(market, invitationId, secret, expiresAt);
    return presented.length === expected.length && timingSafeEqual(presented, expected);
  }

  private mac(
    market: MarketContext,
    invitationId: Id<'Invitation'>,
    secret: Uint8Array,
    expiresAt: Temporal.Instant,
  ): Buffer {
    const message = JSON.stringify([
      market.marketId,
      invitationId,
      Buffer.from(secret).toString('base64url'),
      expiresAt.epochMilliseconds,
    ]);
    return createHmac('sha256', this.#key).update(message).digest();
  }
}
