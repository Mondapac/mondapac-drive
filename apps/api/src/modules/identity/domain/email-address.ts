import { err, ok, type Result } from '@mondapac-drive/shared-kernel';
import { isWellFormedText } from './well-formed-text';

/**
 * A sign-in email address (identity design 2.1 and 11.2; data design 3.3): as typed (trimmed),
 * and normalised, which is the uniqueness and lookup value per Market and population.
 * Normalised means trimmed, NFC and lower-cased; no provider-specific rewriting.
 */
export interface EmailAddress {
  readonly typed: string;
  readonly normalized: string;
}

export type EmailAddressInvalid = { readonly code: 'email.invalid' };

/** Data design 3.3: 3 to 254 characters. */
const MAX_LENGTH = 254;
/** One `@`, something before and after it, no whitespace. */
const SHAPE = /^[^\s@]+@[^\s@]+$/u;
/**
 * Controls (C0, C1), format characters (bidi marks and overrides, U+200B to U+200D, U+FEFF,
 * the soft hyphen) and the line and paragraph separators (HF13; Hassan L3). Stricter than the
 * CHECK of data design 3.3, which stays the backstop.
 */
const FORBIDDEN = /\p{Cc}|\p{Cf}|\p{Zl}|\p{Zp}/u;

/** Parses an address from input. Only the format is checked; delivery proves the mailbox. */
export function parseEmailAddress(raw: unknown): Result<EmailAddress, EmailAddressInvalid> {
  if (typeof raw !== 'string' || !isWellFormedText(raw)) return err({ code: 'email.invalid' });
  const typed = raw.trim();
  if (FORBIDDEN.test(typed) || !SHAPE.test(typed)) return err({ code: 'email.invalid' });
  const normalized = typed.normalize('NFC').toLowerCase();
  for (const value of [typed, normalized]) {
    if (value.length < 3 || value.length > MAX_LENGTH) return err({ code: 'email.invalid' });
  }
  return ok({ typed, normalized });
}
