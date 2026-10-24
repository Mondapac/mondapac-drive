import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { SubjectKeyIntegrityError } from './subject-key-service';

// The algorithms of platform-foundations design 4 row 12 (Hassan): AES-256-GCM with a random
// 96-bit nonce and `authTagLength: 16` on both sides; HKDF-SHA-256 subkeys with separate
// encryption and hash labels; length-prefixed associated data; HMAC-SHA-256, untruncated; a
// versioned envelope. The ciphertext names its format version only (row 2).

const VERSION = 'v1';
const DOMAIN = 'mondapac.subject-key.v1';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** What a field's ciphertext is bound to (PF 4 row 2). The tenant is not bound. */
export interface FieldBinding {
  readonly marketId: string;
  readonly subjectId: string;
  readonly field: string;
}

/** Each part as a 4-byte big-endian length and its UTF-8 bytes: no two lists encode alike. */
export function lengthPrefixed(parts: readonly string[]): Buffer {
  return Buffer.concat(
    parts.flatMap((part) => {
      const bytes = Buffer.from(part, 'utf8');
      const length = Buffer.alloc(4);
      length.writeUInt32BE(bytes.length);
      return [length, bytes];
    }),
  );
}

/** A 32-byte subkey of the data key, separated by its label (HKDF-SHA-256, empty salt). */
function subkey(dataKey: Uint8Array, label: readonly string[]): Buffer {
  return Buffer.from(
    hkdfSync('sha256', dataKey, Buffer.alloc(0), lengthPrefixed(label), KEY_BYTES),
  );
}

const associatedData = (binding: FieldBinding): Buffer =>
  lengthPrefixed([DOMAIN, VERSION, binding.marketId, binding.subjectId, binding.field]);

/** Encrypts one field value: `v1.` and base64url of nonce, ciphertext and tag. */
export function sealField(dataKey: Uint8Array, binding: FieldBinding, plain: string): string {
  const key = subkey(dataKey, [DOMAIN, 'encrypt']);
  try {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(associatedData(binding));
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return `${VERSION}.${Buffer.concat([nonce, body, cipher.getAuthTag()]).toString('base64url')}`;
  } finally {
    key.fill(0);
  }
}

/**
 * Decrypts one field value. Any failure throws {@link SubjectKeyIntegrityError}: an unknown
 * format, or a value that does not authenticate under this key and binding. It is never an
 * erasure (PF 4 row 7).
 */
export function openField(dataKey: Uint8Array, binding: FieldBinding, sealed: string): string {
  const prefix = `${VERSION}.`;
  if (typeof sealed !== 'string' || !sealed.startsWith(prefix)) {
    throw new SubjectKeyIntegrityError('ciphertext-format');
  }
  const encoded = sealed.slice(prefix.length);
  if (!BASE64URL.test(encoded)) throw new SubjectKeyIntegrityError('ciphertext-format');
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.length < NONCE_BYTES + TAG_BYTES) {
    throw new SubjectKeyIntegrityError('ciphertext-authentication');
  }
  const key = subkey(dataKey, [DOMAIN, 'encrypt']);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, NONCE_BYTES), {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(associatedData(binding));
    decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
    const plain = Buffer.concat([
      decipher.update(bytes.subarray(NONCE_BYTES, bytes.length - TAG_BYTES)),
      decipher.final(),
    ]);
    return plain.toString('utf8');
  } catch {
    // The cause names nothing useful and may carry input; it is dropped.
    throw new SubjectKeyIntegrityError('ciphertext-authentication');
  } finally {
    key.fill(0);
  }
}

/**
 * HMAC-SHA-256 under a subkey separated by purpose (PF 4 row 4), untruncated, as 64 lower-case
 * hex characters. Comparable only for one subject and one purpose.
 */
export function keyedHash(dataKey: Uint8Array, purpose: string, data: Uint8Array): string {
  const key = subkey(dataKey, [DOMAIN, 'hmac', purpose]);
  try {
    return createHmac('sha256', key).update(data).digest('hex');
  } finally {
    key.fill(0);
  }
}
