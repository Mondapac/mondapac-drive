import { err, ok, type Result } from '@mondapac-drive/shared-kernel';

/**
 * Why a display name was refused (identity design 8.6 row 1: `validation.failed` with
 * `details.rule`; `characters` added at review for HF13).
 */
export type DisplayNameInvalid = {
  readonly code: 'display-name.invalid';
  readonly rule: 'length' | 'characters';
};

/** Identity design 2.1 and M10: 1 to 100 characters after trimming. */
const MAX_LENGTH = 100;
/**
 * C0 and C1 controls and the bidi marks, embeddings, overrides and isolates: the class of the
 * database CHECK `accounts_display_name_check` (data design 3.3). U+200D (joiner) is allowed.
 */
const FORBIDDEN = /[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
/**
 * URL-like text (HF13; refused by the domain only, data design 3.3): a scheme, a `www.` host, or
 * a dotted host name such as `shop.example.com`. A name like "J. R. Smith" has no dotted token.
 */
const URL_LIKE = [
  /[a-z][a-z0-9+.-]*:\/\//iu,
  /(?:^|[^\p{L}\p{N}])www\./iu,
  /[\p{L}\p{N}-]{2,}\.[\p{L}\p{N}-]+\.[\p{L}]{2,}/iu,
  /[\p{L}\p{N}-]{2,}\.\p{L}{2,}(?:$|[\s/:?#])/iu,
];

/**
 * A person's display name (identity design 2.1, HF13): trimmed; 1 to 100 code points; no
 * control or bidi formatting character; no URL-like text. Personal data: it is never put in an
 * event, a log or an audit row, and it is escaped in every mail.
 */
export function parseDisplayName(raw: unknown): Result<string, DisplayNameInvalid> {
  if (typeof raw !== 'string') return err({ code: 'display-name.invalid', rule: 'length' });
  const name = raw.trim();
  const length = [...name].length;
  if (length < 1 || length > MAX_LENGTH) {
    return err({ code: 'display-name.invalid', rule: 'length' });
  }
  if (FORBIDDEN.test(name) || URL_LIKE.some((pattern) => pattern.test(name))) {
    return err({ code: 'display-name.invalid', rule: 'characters' });
  }
  return ok(name);
}
