import { decodeBase32Secret, encodeBase32, otpauthUri } from './otpauth';

// Slice 7b: how a new secret is shown to its owner (identity design 7.1): the `otpauth://` URI
// that authenticator apps read from a QR code the panel draws, and the same secret as text in
// RFC 4648 base32, which apps accept typed in.

describe('base32 of a TOTP secret (RFC 4648, no padding)', () => {
  it('encodes the RFC 4648 test vectors', () => {
    const vectors: [string, string][] = [
      ['', ''],
      ['f', 'MY'],
      ['fo', 'MZXQ'],
      ['foo', 'MZXW6'],
      ['foob', 'MZXW6YQ'],
      ['fooba', 'MZXW6YTB'],
      ['foobar', 'MZXW6YTBOI'],
    ];
    for (const [plain, encoded] of vectors) {
      expect(encodeBase32(new TextEncoder().encode(plain))).toBe(encoded);
    }
  });

  it('round-trips a 20-byte secret, and reads it typed with spaces or in lower case', () => {
    const secret = Uint8Array.from({ length: 20 }, (_, k) => (k * 37 + 11) % 256);
    const text = encodeBase32(secret);
    expect(text).toHaveLength(32);
    expect(decodeBase32Secret(text)).toEqual(secret);
    expect(decodeBase32Secret(text.toLowerCase().replace(/(.{4})/g, '$1 '))).toEqual(secret);
  });

  it.each([
    ['a secret of another length', 'MZXW6YTBOI'],
    ['a character outside the alphabet', '1'.repeat(32)],
    ['padding', `${'A'.repeat(32)}=`],
    ['not text', 42],
  ])('refuses %s', (_, candidate) => {
    expect(decodeBase32Secret(candidate)).toBeNull();
  });
});

describe('otpauth URI (identity design 7.1)', () => {
  it.each([
    ['AU', 'MondaPac', 'New.Admin@Example.test'],
    ['ZZ', 'MondaPac ZZ', 'zz-admin@example.test'],
  ])(
    'carries the issuer, the account, the secret and the parameters for %s',
    (_, issuer, account) => {
      const secret = new Uint8Array(20).fill(1);
      const uri = new URL(otpauthUri({ issuer, accountName: account, secret }));
      expect(uri.protocol).toBe('otpauth:');
      expect(uri.host).toBe('totp');
      expect(decodeURIComponent(uri.pathname)).toBe(`/${issuer}:${account}`);
      expect(Object.fromEntries(uri.searchParams)).toEqual({
        secret: encodeBase32(secret),
        issuer,
        algorithm: 'SHA1',
        digits: '6',
        period: '30',
      });
    },
  );

  it('escapes a colon or a slash in the issuer or the account', () => {
    const uri = otpauthUri({
      issuer: 'A:B/C',
      accountName: 'x:y@example.test',
      secret: new Uint8Array(20),
    });
    expect(uri.startsWith('otpauth://totp/A%3AB%2FC:x%3Ay%40example.test?')).toBe(true);
  });
});
