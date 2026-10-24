import { err, ok } from './result';
import type { Result } from './result';

/**
 * The text form of a content hash (docs/design/domain/platform-audit.md 6.3; ADR-0020 decision 1,
 * platform-foundations 3.8): `sha256:` plus 64 lowercase hex digits for public content, or
 * `hmac-sha256:` plus 64 lowercase hex digits for personal content hashed under a subject key
 * (ADR-0009 decision 6). The kernel only names and parses it; computing one is I/O-free but
 * needs a hash function, so `platform/hashing/` builds them.
 *
 * The audit seal tables store raw 32-byte hashes; this text form is used at the boundaries
 * only (an anchor, a log line, an operator command, a `content_hash` column).
 */
export type ContentHash = string & { readonly __contentHash: true };

/** The one error of {@link parseContentHash}; it never carries the input. */
export interface ContentHashError {
  readonly code: 'content-hash.malformed';
}

/** The pattern of the `content_hash` CHECKs of the data designs (platform-audit.md 6.3). */
export const CONTENT_HASH_PATTERN = /^(sha256|hmac-sha256):[0-9a-f]{64}$/;

export function parseContentHash(value: unknown): Result<ContentHash, ContentHashError> {
  return typeof value === 'string' && CONTENT_HASH_PATTERN.test(value)
    ? ok(value as ContentHash)
    : err({ code: 'content-hash.malformed' });
}
