import { err, ok } from './result';
import type { Result } from './result';

/**
 * A text field that is stored as given and rendered as text: no HTML interpretation (catalog
 * design 6.3). Parsing refuses bidi controls and default-ignorable characters in every field.
 * ZWNJ and ZWJ are accepted only between two characters of a joining script.
 */
export type PlainText = string & { readonly __plainText: true };

/** Which character was refused, so a panel can say what it found. */
export type InvisibleCharacterKind = 'ZWNJ' | 'ZWJ' | 'other';

/** The first refused character: where it is and what kind. Never the text itself. */
export interface PlainTextError {
  readonly code: 'text.invisible-character';
  /** UTF-16 offset, as a text area counts it. */
  readonly offset: number;
  readonly character: InvisibleCharacterKind;
}

const ZWNJ = 0x200c;
const ZWJ = 0x200d;

// Refused in every field: default-ignorable and bidi characters (design 6.3), and, beyond the
// design's two groups (security review of P1), every other control (C0 and C1, except the line
// feed, carriage return and tab a long text needs), format character, lone surrogate,
// noncharacter and the line and paragraph separators. ZWNJ and ZWJ are Cf and are handled apart.
const REFUSED =
  /[\p{Default_Ignorable_Code_Point}\p{Bidi_Control}\p{Cc}\p{Cf}\p{Cs}\p{Noncharacter_Code_Point}\p{Zl}\p{Zp}]/u;
const ALLOWED_CONTROLS = new Set([0x09, 0x0a, 0x0d]);

// A kernel list keyed by Unicode script, not a Market list (design 6.3): the cursive scripts
// and the Indic scripts, where ZWNJ and ZWJ steer joining.
const JOINING_SCRIPTS = [
  'Arabic',
  'Syriac',
  'Mongolian',
  'Nko',
  'Phags_Pa',
  'Adlam',
  'Mandaic',
  'Manichaean',
  'Psalter_Pahlavi',
  'Hanifi_Rohingya',
  'Sogdian',
  'Old_Sogdian',
  'Chorasmian',
  'Devanagari',
  'Bengali',
  'Gurmukhi',
  'Gujarati',
  'Oriya',
  'Tamil',
  'Telugu',
  'Kannada',
  'Malayalam',
  'Sinhala',
] as const;
const JOINING = new RegExp(
  `^(?:${JOINING_SCRIPTS.map((script) => `\\p{Script=${script}}`).join('|')})$`,
  'u',
);
// A combining mark of the neighbouring letter (script Inherited, e.g. an Arabic vowel sign)
// does not change which script the joining belongs to; the letter before it decides.
const MARK = /^\p{M}$/u;

function joinsOnBothSides(codePoints: readonly string[], index: number): boolean {
  let before = index - 1;
  while (
    before >= 0 &&
    MARK.test(codePoints[before] ?? '') &&
    !JOINING.test(codePoints[before] ?? '')
  ) {
    before -= 1;
  }
  const after = index + 1;
  const left = codePoints[before];
  const right = codePoints[after];
  return left !== undefined && right !== undefined && JOINING.test(left) && JOINING.test(right);
}

/** Accepts a string with no hidden character; refuses with the first offset otherwise. */
export function parsePlainText(text: string): Result<PlainText, PlainTextError> {
  if (typeof text !== 'string')
    return err({ code: 'text.invisible-character', offset: 0, character: 'other' });
  const codePoints = Array.from(text);
  let offset = 0;
  for (const [index, character] of codePoints.entries()) {
    const code = character.codePointAt(0) ?? 0;
    if (code === ZWNJ || code === ZWJ) {
      if (!joinsOnBothSides(codePoints, index)) {
        return err({
          code: 'text.invisible-character',
          offset,
          character: code === ZWNJ ? 'ZWNJ' : 'ZWJ',
        });
      }
    } else if (REFUSED.test(character) && !ALLOWED_CONTROLS.has(code)) {
      return err({ code: 'text.invisible-character', offset, character: 'other' });
    }
    offset += character.length;
  }
  return ok(text as PlainText);
}
