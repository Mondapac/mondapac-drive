import { err, ok, type Result } from '@mondapac-drive/shared-kernel';
import { isWellFormedText } from './well-formed-text';

/** The Market's password rules (identity design 6.5; the `identity.password` section). */
export interface PasswordRules {
  /** Code points after NFKC; at least 15 in every Market. */
  readonly minLength: number;
  /** Code points after NFKC; at most 128. */
  readonly maxLength: number;
}

/** The raw input is refused above this many UTF-8 bytes, before any work (identity design 6.5). */
export const MAX_PASSWORD_BYTES = 1024;

/** Which rule refused (identity design 8.6 row 1: `password.rejected` with `details.rule`). */
export type PasswordRule = 'length' | 'common' | 'contains-identity';

export type PasswordRejected = { readonly code: 'password.rejected'; readonly rule: PasswordRule };

const UTF8 = new TextEncoder();

/** What the new password may not equal: the account's email and, when it has one, its name. */
export interface PasswordIdentity {
  readonly email: string;
  readonly displayName: string | null;
}

/** The form compared with the common list and the identity: NFKC, then lower-cased. */
export function comparablePassword(plain: string): string {
  return plain.normalize('NFKC').toLowerCase();
}

/**
 * Checks a new password against the rules of identity design 6.5 (Hassan; NIST SP 800-63B-4):
 * 15 to 128 code points after NFKC (the Market's numbers), the raw input at most 1024 bytes, not
 * equal to the email or the name, not on the common list. No composition rules, no rotation.
 * The password is never trimmed or truncated, and never part of an answer or an error.
 *
 * `isCommon` receives the {@link comparablePassword} form.
 */
export function checkNewPassword(
  plain: string,
  rules: PasswordRules,
  identity: PasswordIdentity,
  isCommon: (comparable: string) => boolean,
): Result<void, PasswordRejected> {
  const refuse = (rule: PasswordRule) => err({ code: 'password.rejected' as const, rule });
  // A lone surrogate cannot be encoded as UTF-8 without loss, so the hash would not be of what
  // was typed (Hassan L3): refused with the input-size rule, like a non-string.
  if (
    typeof plain !== 'string' ||
    !isWellFormedText(plain) ||
    UTF8.encode(plain).length > MAX_PASSWORD_BYTES
  ) {
    return refuse('length');
  }
  const normalized = plain.normalize('NFKC');
  const length = [...normalized].length;
  if (length < rules.minLength || length > rules.maxLength) return refuse('length');

  const comparable = normalized.toLowerCase();
  const own = [identity.email, identity.displayName]
    .filter((value): value is string => value !== null)
    .map((value) => comparablePassword(value.trim()));
  if (own.includes(comparable)) return refuse('contains-identity');
  if (isCommon(comparable)) return refuse('common');
  return ok(undefined);
}
