/**
 * A lone surrogate. With the `u` flag a well-formed surrogate pair is one code point and never
 * matches `\p{Cs}`, so this finds exactly the code units that make a string ill-formed.
 */
const LONE_SURROGATE = /\p{Cs}/u;

/**
 * Whether a string is well-formed UTF-16 (no lone surrogate), as `String.prototype.isWellFormed`
 * of ES2024, which the ES2023 library of this repository does not type yet (Hassan L3). Such a
 * string cannot be encoded as UTF-8 without loss, so an email or a password holding one is
 * refused rather than silently replaced.
 */
export function isWellFormedText(text: string): boolean {
  return !LONE_SURROGATE.test(text);
}
