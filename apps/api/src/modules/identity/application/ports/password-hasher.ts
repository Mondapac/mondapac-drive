import type { Result } from '@mondapac-drive/shared-kernel';

/**
 * The hash queue is full (identity design 6.5): answered 503 `request.busy` with
 * `retryAfterSeconds`. Nothing was hashed.
 */
export type PasswordHasherBusy = {
  readonly code: 'request.busy';
  readonly retryAfterSeconds: number;
};

/** The outcome of {@link PasswordHasher.verify}. */
export interface PasswordVerification {
  readonly matches: boolean;
  /** The stored hash uses older parameters: replace it at the next successful sign-in. */
  readonly needsRehash: boolean;
}

/**
 * Password hashing (identity design 6.5): argon2id through Node's built-in `crypto.argon2`,
 * stored as a PHC string. Hashing is slow work: a use case calls it outside any unit of work
 * (platform persistence 3.1 row 5), and a process runs at most two hashes at once with at most
 * sixteen waiting; a call beyond that is refused at once with `request.busy`.
 *
 * **One hash input (Hassan L1; identity design 6.5).** Both `hash` and `verify` hash the
 * password's Unicode NFKC form, the form whose length the rules count (NIST SP 800-63B-4), so a
 * password typed with another composition of the same characters matches. Accounts made before
 * this rule need no fallback: none exist outside development and test.
 *
 * The plain password is never logged, returned or put in an error.
 */
export interface PasswordHasher {
  hash(plain: string): Promise<Result<string, PasswordHasherBusy>>;
  /**
   * Checks a password against a stored PHC string. With `stored` null (no account), it checks
   * against a dummy hash with the current parameters and answers no match, so a sign-in for an
   * unknown address costs the same as one for a known address (HF12).
   */
  verify(
    plain: string,
    stored: string | null,
  ): Promise<Result<PasswordVerification, PasswordHasherBusy>>;
}

/** Nest token of the {@link PasswordHasher}. */
export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');
