import { checkNewPassword, MAX_PASSWORD_BYTES, type PasswordRules } from './password-policy';

// Both Market fixtures' rules: AU 15 to 128, ZZ 16 to 100 (config/markets, test/fixtures).
const AU: PasswordRules = { minLength: 15, maxLength: 128 };
const ZZ: PasswordRules = { minLength: 16, maxLength: 100 };
const IDENTITY = { email: 'customer.one@example.com', displayName: 'Customer One Example' };
const NOT_COMMON = (): boolean => false;
const rejected = (rule: string) => ({ ok: false, error: { code: 'password.rejected', rule } });

describe('checkNewPassword (identity design 6.5)', () => {
  it('accepts a password of the minimum length for each Market', () => {
    expect(checkNewPassword('a'.repeat(15) + '', AU, IDENTITY, NOT_COMMON).ok).toBe(true);
    expect(checkNewPassword('b'.repeat(16), ZZ, IDENTITY, NOT_COMMON).ok).toBe(true);
  });

  it('applies the Market rules: 15 code points pass in AU and fail in ZZ', () => {
    const password = 'correct horse b'; // 15 code points

    expect(checkNewPassword(password, AU, IDENTITY, NOT_COMMON).ok).toBe(true);
    expect(checkNewPassword(password, ZZ, IDENTITY, NOT_COMMON)).toEqual(rejected('length'));
  });

  it('counts code points after NFKC, not UTF-16 units or bytes', () => {
    // 15 emoji: 30 UTF-16 units, 60 bytes, 15 code points.
    expect(checkNewPassword('😀'.repeat(15), AU, IDENTITY, NOT_COMMON).ok).toBe(true);
    // 14 code points: refused although its UTF-16 length is 28.
    expect(checkNewPassword('😀'.repeat(14), AU, IDENTITY, NOT_COMMON)).toEqual(rejected('length'));
    // A ligature expands under NFKC: 'ﬃ' is three code points after normalisation.
    expect(checkNewPassword('ﬃ'.repeat(5), AU, IDENTITY, NOT_COMMON).ok).toBe(true);
  });

  it('refuses more than the maximum, and more than 1024 bytes before normalising', () => {
    expect(checkNewPassword('c'.repeat(129), AU, IDENTITY, NOT_COMMON)).toEqual(rejected('length'));
    expect(checkNewPassword('c'.repeat(101), ZZ, IDENTITY, NOT_COMMON)).toEqual(rejected('length'));
    // 128 code points but 4 bytes each: 512 bytes, accepted.
    expect(checkNewPassword('😀'.repeat(128), AU, IDENTITY, NOT_COMMON).ok).toBe(true);
    // Raw input over the byte bound is refused before any normalisation.
    const huge = 'é'.repeat(MAX_PASSWORD_BYTES);
    expect(checkNewPassword(huge, AU, IDENTITY, NOT_COMMON)).toEqual(rejected('length'));
  });

  it('never truncates: one code point too many is refused, not shortened', () => {
    expect(checkNewPassword('d'.repeat(128) + 'e', AU, IDENTITY, NOT_COMMON)).toEqual(
      rejected('length'),
    );
  });

  it('refuses a password on the common list, comparing the NFKC, lower-cased form', () => {
    const seen: string[] = [];
    const isCommon = (candidate: string): boolean => {
      seen.push(candidate);
      return candidate === '1qaz2wsx3edc4rfv';
    };

    expect(checkNewPassword('1QAZ2WSX3EDC4RFV', AU, IDENTITY, isCommon)).toEqual(
      rejected('common'),
    );
    expect(seen).toEqual(['1qaz2wsx3edc4rfv']);
  });

  it('refuses a password equal to the email or to the display name', () => {
    // Never trimmed: a leading space makes another password.
    expect(checkNewPassword(' Customer.One@Example.com', AU, IDENTITY, NOT_COMMON).ok).toBe(true);
    expect(checkNewPassword('Customer.One@Example.com', AU, IDENTITY, NOT_COMMON)).toEqual(
      rejected('contains-identity'),
    );
    expect(checkNewPassword('CUSTOMER ONE EXAMPLE', AU, IDENTITY, NOT_COMMON)).toEqual(
      rejected('contains-identity'),
    );
  });

  it('checks the email alone when the account has no display name', () => {
    const identity = { email: 'customer.one@example.com', displayName: null };

    expect(checkNewPassword('customer.one@example.com', AU, identity, NOT_COMMON)).toEqual(
      rejected('contains-identity'),
    );
    expect(checkNewPassword('a different long passphrase', AU, identity, NOT_COMMON).ok).toBe(true);
  });

  it('keeps whitespace and composition rules out: spaces count and any characters pass', () => {
    expect(checkNewPassword('               ', AU, IDENTITY, NOT_COMMON).ok).toBe(true);
    expect(checkNewPassword('пароль-для-магазина', AU, IDENTITY, NOT_COMMON).ok).toBe(true);
  });

  it('refuses a value that is not a string', () => {
    expect(checkNewPassword(12345 as unknown as string, AU, IDENTITY, NOT_COMMON)).toEqual(
      rejected('length'),
    );
  });

  it.each([
    ['a lone high surrogate', 0xd800],
    ['a lone low surrogate', 0xdc00],
  ])('refuses a password holding %s (Hassan L3), with the length rule', (_case, unit) => {
    const password = `correct horse ${String.fromCharCode(unit)} battery`;

    for (const rules of [AU, ZZ]) {
      expect(checkNewPassword(password, rules, IDENTITY, NOT_COMMON)).toEqual(rejected('length'));
    }
  });

  it('accepts a well-formed surrogate pair', () => {
    const password = `correct horse ${String.fromCodePoint(0x1f600)} battery`;

    expect(checkNewPassword(password, ZZ, IDENTITY, NOT_COMMON).ok).toBe(true);
  });
});
