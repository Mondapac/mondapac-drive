import { CryptoTrackingTokens } from './crypto-tracking-tokens';

describe('tracking-link tokens', () => {
  const tokens = new CryptoTrackingTokens();

  it('issues 43-character base64url tokens with 256 bits, each different, stored as SHA-256', () => {
    const issued = Array.from({ length: 50 }, () => tokens.issue());
    expect(new Set(issued.map((i) => i.token)).size).toBe(50);
    for (const { token, hash } of issued) {
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(hash).not.toContain(token);
      expect(tokens.hashOf(token)).toBe(hash);
    }
  });

  it('hashes nothing that does not have the shape of a token', () => {
    expect(tokens.hashOf('')).toBeUndefined();
    expect(tokens.hashOf('a'.repeat(42))).toBeUndefined();
    expect(tokens.hashOf(`${'a'.repeat(42)}=`)).toBeUndefined();
  });
});
