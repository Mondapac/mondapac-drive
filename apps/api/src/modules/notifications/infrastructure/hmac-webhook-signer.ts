import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Temporal } from '@mondapac-drive/shared-kernel';
import type { WebhookSigner } from '../application/ports';
import {
  isFresh,
  parseTimestamp,
  signatureDigests,
  signedContent,
} from '../domain/webhook-signature';

/**
 * Signs with HMAC-SHA256. A subscription's secret is
 * `base64url(HMAC-SHA256(webhookKey, "drive.webhook-secret.v1:<subscription id>:<version>"))`,
 * so no secret is stored and a rotation is a version step.
 */
export class HmacWebhookSigner implements WebhookSigner {
  readonly #key: Uint8Array;

  constructor(key: Uint8Array) {
    this.#key = key;
  }

  secretFor(subscriptionId: string, secretVersion: number): string {
    if (!Number.isInteger(secretVersion) || secretVersion < 1) {
      throw new RangeError('A secret version starts at 1');
    }
    return createHmac('sha256', this.#key)
      .update(`drive.webhook-secret.v1:${subscriptionId}:${secretVersion}`)
      .digest('base64url');
  }

  sign(subscriptionId: string, secretVersion: number, content: string): string {
    return hmacHex(this.secretFor(subscriptionId, secretVersion), content);
  }
}

function hmacHex(secret: string, content: string): string {
  return createHmac('sha256', secret).update(content, 'utf8').digest('hex');
}

/**
 * The receiver's check, as the marketplace implements it (docs/notifications/webhooks.md):
 * the timestamp is fresh and one `v1` digest equals the HMAC of `<timestamp>.<raw body>` under
 * the secret, compared in constant time. Kept here as the reference the tests pin.
 */
export function verifyWebhookSignature(input: {
  readonly secret: string;
  readonly timestampHeader: string;
  readonly signatureHeader: string;
  readonly rawBody: string;
  readonly now: Temporal.Instant;
}): boolean {
  const timestamp = parseTimestamp(input.timestampHeader);
  if (timestamp === undefined || !isFresh(timestamp, input.now)) return false;
  const expected = Buffer.from(
    hmacHex(input.secret, signedContent(timestamp, input.rawBody)),
    'hex',
  );
  return signatureDigests(input.signatureHeader).some((digest) =>
    timingSafeEqual(Buffer.from(digest, 'hex'), expected),
  );
}
