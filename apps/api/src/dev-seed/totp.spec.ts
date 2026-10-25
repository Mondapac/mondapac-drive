import { decodeBase32, totpCode } from './totp';

// RFC 6238 appendix B, SHA-1: the secret "12345678901234567890", eight-digit codes, of which
// the last six digits are the six-digit code an authenticator app shows.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('totpCode', () => {
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
  ])('matches RFC 6238 at %i s', (seconds, eight) => {
    expect(totpCode(RFC_SECRET, seconds * 1000)).toBe(eight.slice(2));
  });

  it('keeps one code for a 30-second step', () => {
    expect(totpCode(RFC_SECRET, 30_000)).toBe(totpCode(RFC_SECRET, 59_999));
    expect(totpCode(RFC_SECRET, 60_000)).not.toBe(totpCode(RFC_SECRET, 59_999));
  });

  it('decodes base32 in either case and refuses other text', () => {
    expect(decodeBase32(RFC_SECRET.toLowerCase()).toString()).toBe('12345678901234567890');
    expect(() => decodeBase32('not-base32!')).toThrow('not a base32 secret');
  });
});
