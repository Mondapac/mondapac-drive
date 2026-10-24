import { createHash } from 'node:crypto';
import { parseContentHash } from '@mondapac-drive/shared-kernel';
import type { ContentHash } from '@mondapac-drive/shared-kernel';

/**
 * The builders of the kernel's `ContentHash` (docs/design/domain/platform-audit.md 6.3;
 * ADR-0020 decision 1, platform-foundations 3.8). The kernel names and parses the text form;
 * hashing needs Node's crypto, so it lives here.
 */

/** `sha256:<hex>` of public content (catalog, an audit anchor): no key, anyone can recompute it. */
export function sha256ContentHash(bytes: Uint8Array): ContentHash {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('sha256ContentHash: bytes expected');
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}` as ContentHash;
}

/**
 * `hmac-sha256:<hex>` of personal content (sellers, certification; ADR-0009 decision 6): wraps
 * the lowercase hex that `SubjectKeyService.hmac` returns, so the hash is keyed by the subject
 * and dies with the subject's key. Anything but 64 lowercase hex digits is a programmer error.
 *
 * Pass it only the output of `SubjectKeyService.hmac` (Hassan I1 on slice 6a). It checks the
 * form, not the origin: given `sha256` hex, or hex of any other unkeyed digest, it would label
 * a hash anyone can recompute as keyed personal content, which crypto-shredding cannot erase.
 */
export function hmacContentHash(hex: string): ContentHash {
  const parsed = parseContentHash(`hmac-sha256:${hex}`);
  if (!parsed.ok) throw new TypeError('hmacContentHash: 64 lowercase hex digits expected');
  return parsed.value;
}
