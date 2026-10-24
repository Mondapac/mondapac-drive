import type { Id, MarketContext, Temporal } from '@mondapac-drive/shared-kernel';
import type { LinkTokens } from './link-secrets';

/**
 * Random opaque tokens of one kind (identity design 6.2, 6.6): 32 bytes from the system random
 * source, base64url, behind a prefix of their own, so a token of one kind is never taken for
 * another. Only the SHA-256 of a token is stored.
 */
export type OpaqueTokens = LinkTokens;

/**
 * The tokens of sign-in challenges (identity design 2.1, 6.3 step 5; slice 7b). A challenge's
 * token is handed to the panel in the answer that asks for a code and posted back with it; it is
 * never a credential and never an actor (I1).
 */
export const CHALLENGE_TOKENS = Symbol('CHALLENGE_TOKENS');

/**
 * The tokens of invitations (identity design 3.4, 6.6; slice 7b): minted at dispatch by the mail
 * handler and put only in the fragment of the mailed link.
 */
export const INVITATION_TOKENS = Symbol('INVITATION_TOKENS');

/**
 * The tag that binds the secret of an admin's first enrolment to its invitation (identity design
 * 3.4, HF6): the acceptance's first request returns a new secret, an expiry 15 minutes ahead and
 * this tag, and stores nothing; the request that accepts presents all three back with a code. The
 * tag is HMAC-SHA-256 under a key derived from the stack secret of 6.8 with its own label, over
 * the Market, the invitation, the secret and the expiry, so a secret cannot be moved to another
 * invitation or have its expiry extended.
 */
export interface EnrolmentSecretTags {
  tag(
    market: MarketContext,
    invitationId: Id<'Invitation'>,
    secret: Uint8Array,
    expiresAt: Temporal.Instant,
  ): string;

  /** Whether `tag` is this secret's tag, compared in constant time. */
  matches(
    market: MarketContext,
    invitationId: Id<'Invitation'>,
    secret: Uint8Array,
    expiresAt: Temporal.Instant,
    tag: string,
  ): boolean;
}

/** Nest token of the {@link EnrolmentSecretTags}. */
export const ENROLMENT_SECRET_TAGS = Symbol('ENROLMENT_SECRET_TAGS');
