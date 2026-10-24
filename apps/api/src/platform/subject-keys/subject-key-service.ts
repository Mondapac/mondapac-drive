import type { Id, MarketContext, Result } from '@mondapac-drive/shared-kernel';
import type { FieldLabel, HashPurpose } from './labels';

/** The one expected failure of a data operation: the subject's key was destroyed (erasure). */
export type SubjectKeyDestroyed = { readonly code: 'subject-key.destroyed' };

/** The answer of a data operation (PF 4). */
export type Keyed<T> = Promise<Result<T, SubjectKeyDestroyed>>;

/**
 * One data key per subject (platform-foundations design 4; ADR-0009 decisions 6 and 8): a
 * person's personal fields become unreadable for ever when their key is destroyed, while
 * history and hash chains stay intact.
 *
 * Guarantees, whatever the adapter (PF 4):
 * 1. One data key per subject for life, generated inside the service and stored only wrapped
 *    under the Region Stack's wrapping key. No operation returns a key; key material and
 *    plaintext never reach logs, errors, events or audit rows.
 * 2. Encryption is authenticated, randomised and bound to the Market, the subject and the
 *    field: a value copied elsewhere does not decrypt. Ciphertext is never compared, indexed
 *    or unique.
 * 3. Labels and purposes are constants of the owning module (`fieldLabel`, `hashPurpose`).
 * 4. `hmac` uses a key derived from the data key and separated by purpose; it cannot back an
 *    equality search across subjects.
 * 5. `createKey` throws `SubjectKeyExistsError` if the subject ever had a key; `destroyKey`
 *    keeps a tombstone and is idempotent.
 * 6. After destruction the data operations answer `subject-key.destroyed`; a subject that never
 *    had a key is a programmer error and throws `SubjectKeyMissingError`.
 * 7. A failure is never an erasure: an unwrap failure or a failed authentication tag throws,
 *    and encryption never falls back to plaintext.
 * 8. `createKey` and `destroyKey` write in the caller's open read-write unit; the data
 *    operations read the key row through the open unit when there is one (so registration
 *    reads its own uncommitted key), otherwise in a read-only unit of their own.
 * 9. No cache of unwrapped keys: one unwrap per operation.
 *
 * Repositories and this service take the `MarketContext` only (foundations 5.2 rule 2).
 */
export interface SubjectKeyService {
  createKey(market: MarketContext, subject: Id): Promise<void>;
  encrypt(market: MarketContext, subject: Id, field: FieldLabel, plain: string): Keyed<string>;
  decrypt(market: MarketContext, subject: Id, field: FieldLabel, cipher: string): Keyed<string>;
  hmac(market: MarketContext, subject: Id, purpose: HashPurpose, data: Uint8Array): Keyed<string>;
  destroyKey(market: MarketContext, subject: Id): Promise<void>;
}

/** Nest token of the {@link SubjectKeyService}. */
export const SUBJECT_KEY_SERVICE = Symbol('SUBJECT_KEY_SERVICE');

/** `createKey` for a subject that already has, or once had, a key (PF 4 row 5). */
export class SubjectKeyExistsError extends Error {
  override readonly name = 'SubjectKeyExistsError';
  constructor() {
    super('The subject already has a data key; a subject has one key for life');
  }
}

/** A data operation or `destroyKey` for a subject that never had a key (PF 4 row 6). */
export class SubjectKeyMissingError extends Error {
  override readonly name = 'SubjectKeyMissingError';
  constructor() {
    super('The subject has no data key in this Market: create it first');
  }
}

/**
 * Ciphertext that does not authenticate, has an unknown format, or a key that does not unwrap
 * (PF 4 row 7). Never reported as `subject-key.destroyed`. Carries no value.
 */
export class SubjectKeyIntegrityError extends Error {
  override readonly name = 'SubjectKeyIntegrityError';
  constructor(readonly reason: 'ciphertext-format' | 'ciphertext-authentication' | 'unwrap') {
    super(`A subject-key operation failed its integrity check: ${reason}`);
  }
}
