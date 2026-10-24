import type { Id, MarketContext, Temporal } from '@mondapac-drive/shared-kernel';

/** A row of `platform.subject_keys` (data design 3.2), as the service reads it. */
export interface StoredSubjectKey {
  readonly subjectId: Id;
  readonly keyVersion: number;
  /** `null` once destroyed: the row is then a tombstone. */
  readonly wrappedKey: string | null;
  readonly wrappingKeyId: string;
  readonly destroyedAt: Temporal.Instant | null;
}

/** A new key row; the store adds the Market and tenant from the `MarketContext`. */
export interface NewSubjectKey {
  readonly subjectId: Id;
  readonly keyVersion: number;
  readonly wrappedKey: string;
  readonly wrappingKeyId: string;
  readonly createdAt: Temporal.Instant;
}

/**
 * The key table behind the {@link SubjectKeyService} (PF 4 row 13): declared here, implemented
 * in `platform/persistence/`, so the persistence rules stay unchanged. Every query names the
 * Market (the guard checks it), so a key of one Market is invisible in another.
 *
 * - `insert` and `destroy` need the caller's open read-write unit (PF 4 row 8); `insert` throws
 *   `SubjectKeyExistsError` when the subject has, or once had, a key (the primary key).
 * - `find` reads through the open unit when there is one, otherwise in a read-only unit of its
 *   own (platform persistence 3.3).
 * - `destroy` sets the tombstone once; a second call changes no row. It throws
 *   `SubjectKeyMissingError` for a subject that never had a key in this Market.
 */
export interface SubjectKeyStore {
  insert(market: MarketContext, key: NewSubjectKey): Promise<void>;
  find(market: MarketContext, subjectId: Id): Promise<StoredSubjectKey | null>;
  destroy(market: MarketContext, subjectId: Id, destroyedAt: Temporal.Instant): Promise<void>;
}

/** Nest token of the {@link SubjectKeyStore}; provided by the persistence module. */
export const SUBJECT_KEY_STORE = Symbol('SUBJECT_KEY_STORE');
