import { parseEmailAddress } from './email-address';

describe('parseEmailAddress (identity design 11.2; data design 3.3)', () => {
  it('keeps the address as typed, trimmed, and normalises it: trimmed, NFC, lower-cased', () => {
    const parsed = parseEmailAddress('  Customer.One@Example.COM ');

    expect(parsed).toEqual({
      ok: true,
      value: { typed: 'Customer.One@Example.COM', normalized: 'customer.one@example.com' },
    });
  });

  it('composes a decomposed accent (NFC) and folds non-ASCII upper case', () => {
    const parsed = parseEmailAddress('Ze\u0301LIE@EX\u00c4MPLE.de');

    expect(parsed.ok && parsed.value.normalized).toBe('z\u00e9lie@ex\u00e4mple.de');
  });

  it('does no provider-specific rewriting (dots and plus tags stay)', () => {
    const parsed = parseEmailAddress('first.last+shop@gmail.com');

    expect(parsed.ok && parsed.value.normalized).toBe('first.last+shop@gmail.com');
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['without @', 'customer.example.com'],
    ['with @ first', '@example.com'],
    ['with @ last', 'customer@'],
    ['with two @', 'a@b@example.com'],
    ['with inner space', 'cus tomer@example.com'],
    ['with a control character', 'customer\u0000@example.com'],
    ['with a newline', 'customer@example.com\nBcc: x@example.com'],
    ['with a bidi override', 'customer\u202e@example.com'],
    ['longer than 254 characters', `${'a'.repeat(250)}@example.com`],
    ['not a string', 42],
  ])('refuses an address %s', (_case, raw) => {
    expect(parseEmailAddress(raw)).toEqual({ ok: false, error: { code: 'email.invalid' } });
  });

  // Hassan L3: format characters, line and paragraph separators, and ill-formed UTF-16.
  it.each([
    ['a zero-width space (U+200B)', 0x200b],
    ['a zero-width non-joiner (U+200C)', 0x200c],
    ['a zero-width joiner (U+200D)', 0x200d],
    ['a byte-order mark (U+FEFF)', 0xfeff],
    ['a soft hyphen (U+00AD)', 0xad],
    ['a line separator (U+2028)', 0x2028],
    ['a paragraph separator (U+2029)', 0x2029],
    ['an Arabic letter mark (U+061C)', 0x61c],
    ['a lone high surrogate', 0xd800],
    ['a lone low surrogate', 0xdc00],
  ])('refuses an address with %s', (_case, codePoint) => {
    const raw = `cust${String.fromCharCode(codePoint)}omer@example.com`;

    expect(parseEmailAddress(raw)).toEqual({ ok: false, error: { code: 'email.invalid' } });
  });

  it('accepts a well-formed astral character (a surrogate pair)', () => {
    const raw = `cust${String.fromCodePoint(0x1f600)}omer@example.com`;

    expect(parseEmailAddress(raw).ok).toBe(true);
  });
});
