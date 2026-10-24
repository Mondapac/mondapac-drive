/**
 * What a wrapped key is bound to (PF 4 row 10): a wrapped key moved to another row (another
 * subject, Market or key version) does not unwrap. The tenant is not bound (PF 4 row 2).
 */
export interface KeyBinding {
  readonly marketId: string;
  readonly subjectId: string;
  readonly keyVersion: number;
}

/** A data key wrapped under the regional wrapping key, as stored in `subject_keys`. */
export interface WrappedKey {
  /** A versioned text envelope; its format is the adapter's (K1, Kazem). */
  readonly wrappedKey: string;
  /** Which regional wrapping key and version wrapped it. */
  readonly wrappingKeyId: string;
}

/**
 * The regional wrapping key (platform-foundations design 4 row 10). One wrapping key per Region
 * Stack, not one per subject. The deployed adapter (a key service) is designed by Kazem with the
 * first deployed environment; until then the local stand-in serves development and CI and
 * refuses to start in production.
 *
 * Both methods throw on any failure; an unwrap failure is never an erasure (PF 4 row 7).
 */
export interface KeyWrapper {
  wrap(binding: KeyBinding, dataKey: Uint8Array): Promise<WrappedKey>;
  unwrap(binding: KeyBinding, wrapped: WrappedKey): Promise<Uint8Array>;
}

/** Nest token of the {@link KeyWrapper}; bound by the subject-keys module and not exported. */
export const KEY_WRAPPER = Symbol('KEY_WRAPPER');
