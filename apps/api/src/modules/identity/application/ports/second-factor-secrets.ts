import type { Id, MarketContext } from '@mondapac-drive/shared-kernel';
import type { RecoveryCode } from '../../domain/recovery-code';

/**
 * The secrets of the second factor (identity design 7.1, 7.3, 7.5; Hassan H2): the one place
 * that generates a TOTP secret, encrypts and decrypts it, checks a code and hashes a recovery
 * code. Built on `node:crypto` with the account's subject key (`SubjectKeyService`), so no
 * package is needed (identity design 13). A plaintext secret leaves this port only once, from
 * {@link newSecret}, for the enrolment answer that shows it to its owner; a stored secret is
 * decrypted only inside {@link matchStored}. Nothing here is logged.
 */
export interface SecondFactorSecrets {
  /** A new 160-bit secret from the system random source (7.5). */
  newSecret(): Uint8Array;

  /**
   * The secret encrypted under the account's subject key, label
   * `identity.second-factor.secret` (7.5), for `second_factors.secret_ciphertext` or
   * `pending_secret_ciphertext`. Throws {@link SecondFactorKeyUnavailableError} when the
   * account's key was destroyed.
   */
  seal(market: MarketContext, accountId: Id<'Account'>, secret: Uint8Array): Promise<string>;

  /**
   * The first of `steps` (in the order given) at which `code` is the TOTP of the stored secret,
   * or null when none is (7.1). The secret is decrypted here and nowhere else; its decoded bytes
   * are zeroed after use (best effort: the decrypted text is a string, which cannot be). A
   * destroyed key throws {@link SecondFactorKeyUnavailableError} (slice 7b): no code matches an
   * erased account, and the caller alarms on it (Hassan I-3). A ciphertext that does not open
   * under this account's key and label throws `SubjectKeyIntegrityError`; it never matches.
   */
  matchStored(
    market: MarketContext,
    accountId: Id<'Account'>,
    secretCiphertext: string,
    code: string,
    steps: readonly number[],
  ): Promise<number | null>;

  /**
   * As {@link matchStored} for a secret that is not stored yet: the secret of an admin's
   * invitation acceptance, returned to the request with its tag and proved by the first code
   * before anything is stored (identity design 3.4, HF6).
   */
  matchPlain(secret: Uint8Array, code: string, steps: readonly number[]): number | null;

  /** Ten new recovery codes from the system random source (7.3), in canonical form. */
  newRecoveryCodes(): RecoveryCode[];

  /**
   * The keyed hash of a recovery code: `SubjectKeyService.hmac` under the account's key with the
   * purpose `identity.recovery-code` (H2), 32 bytes, as `recovery_codes.code_hash` stores it.
   * Throws {@link SecondFactorKeyUnavailableError} when the account's key was destroyed.
   */
  recoveryCodeHash(
    market: MarketContext,
    accountId: Id<'Account'>,
    code: RecoveryCode,
  ): Promise<Uint8Array>;
}

/** Nest token of the {@link SecondFactorSecrets}. */
export const SECOND_FACTOR_SECRETS = Symbol('SECOND_FACTOR_SECRETS');

/** The account's subject key was destroyed (erasure): no secret can be sealed or hashed. */
export class SecondFactorKeyUnavailableError extends Error {
  override readonly name = 'SecondFactorKeyUnavailableError';
  constructor() {
    super("identity: the account's subject key is destroyed");
  }
}
