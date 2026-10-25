import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import type { ExpoPushToken } from '../domain/push-device';

const SEAL_INFO = 'mondapac-drive.notifications.push-token.seal.v1';
const LOOKUP_INFO = 'mondapac-drive.notifications.push-token.lookup.v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** The prefix of a sealed token: the format version, so a later key or cipher can coexist. */
const SEALED_PREFIX = 'v1.';

/** A sealed token could not be opened: another key, another account, or a changed row. */
export class PushTokenSealError extends Error {
  override readonly name = 'PushTokenSealError';
}

/**
 * Seals courier push tokens at rest (handoff 33: "encrypted or hashed + sealed"). Two keys are
 * derived with HKDF-SHA256 from the deployment's notifications key (`NOTIFICATIONS_WEBHOOK_KEY`):
 * one for AES-256-GCM, bound to the device's account (associated data), and one for the keyed
 * digest that finds a token without opening every row. Rotating the notifications key makes
 * every stored token unreadable; the app registers its device again at its next start.
 */
export class PushTokenSeal {
  readonly #sealKey: Buffer;
  readonly #lookupKey: Buffer;

  constructor(rootKey: Uint8Array) {
    this.#sealKey = Buffer.from(hkdfSync('sha256', rootKey, Buffer.alloc(0), SEAL_INFO, 32));
    this.#lookupKey = Buffer.from(hkdfSync('sha256', rootKey, Buffer.alloc(0), LOOKUP_INFO, 32));
  }

  /** `v1.` and base64url of iv, ciphertext and tag. */
  seal(token: ExpoPushToken, accountId: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.#sealKey, iv);
    cipher.setAAD(Buffer.from(accountId, 'utf8'));
    const body = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return SEALED_PREFIX + Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url');
  }

  open(sealed: string, accountId: string): ExpoPushToken {
    if (!sealed.startsWith(SEALED_PREFIX)) throw new PushTokenSealError('Unknown seal format');
    const raw = Buffer.from(sealed.slice(SEALED_PREFIX.length), 'base64url');
    if (raw.length <= IV_BYTES + TAG_BYTES) throw new PushTokenSealError('Sealed token too short');
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#sealKey, raw.subarray(0, IV_BYTES));
      decipher.setAAD(Buffer.from(accountId, 'utf8'));
      decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
      const plain = Buffer.concat([
        decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)),
        decipher.final(),
      ]);
      return plain.toString('utf8') as ExpoPushToken;
    } catch {
      throw new PushTokenSealError('The sealed token does not open');
    }
  }

  /** The keyed digest of a token (hex), unique per Market: finds the session that holds it. */
  lookup(token: ExpoPushToken): string {
    return createHmac('sha256', this.#lookupKey).update(token, 'utf8').digest('hex');
  }
}
