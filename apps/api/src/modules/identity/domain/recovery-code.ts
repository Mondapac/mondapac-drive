/**
 * Recovery codes (identity design 7.3; Hassan H2): ten single-use codes of ten characters of
 * Crockford's base32, shown once at enrolment and stored only as a keyed hash under the
 * account's subject key. Ten characters of a 32-symbol alphabet are 50 bits each; the guesses
 * are bounded by the challenge's five attempts and the `second-factor.account` counter (HF2).
 */
export const RECOVERY_CODES = Object.freeze({
  /** Codes per factor; also the CHECK on `recovery_codes.position` (data design 3.10). */
  count: 10,
  /** Characters per code. */
  length: 10,
  /** Crockford's base32 alphabet: digits and letters without I, L, O and U. */
  alphabet: '0123456789ABCDEFGHJKMNPQRSTVWXYZ',
} as const);

const CANONICAL = new RegExp(`^[${RECOVERY_CODES.alphabet}]{${RECOVERY_CODES.length}}$`);

/** A recovery code in its canonical form: ten upper-case symbols of the alphabet, no separator. */
export type RecoveryCode = string & { readonly __brand: 'RecoveryCode' };

/**
 * Reads a code as a person types it (Crockford's decoding rules): case does not matter, `I` and
 * `L` read as `1`, `O` as `0`, and hyphens and spaces are ignored. Null when what is left is not
 * ten symbols of the alphabet (`U` included, which Crockford excludes). The answer is the one
 * form that is hashed, so "abcde-fghjk" and "ABCDEFGHJK" are the same code.
 */
export function parseRecoveryCode(raw: unknown): RecoveryCode | null {
  if (typeof raw !== 'string' || raw.length > 32) return null;
  const canonical = raw
    .replace(/[\s-]/g, '')
    .toUpperCase()
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  return CANONICAL.test(canonical) ? (canonical as RecoveryCode) : null;
}

/**
 * The display form, two groups of five ("ABCDE-FGHJK"), for the one time the codes are shown.
 * The hyphen is ignored when a code is typed back.
 */
export function displayRecoveryCode(code: RecoveryCode): string {
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}
