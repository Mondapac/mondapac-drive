import { parseContentHash } from '@mondapac-drive/shared-kernel';
import { hmacContentHash, sha256ContentHash } from './content-hash';

describe('content hash builders (platform-audit.md 6.3)', () => {
  it('hashes bytes as sha256:<64 lowercase hex> (FIPS 180-2 vectors)', () => {
    expect(sha256ContentHash(new Uint8Array())).toBe(
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256ContentHash(new TextEncoder().encode('abc'))).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('produces what the kernel parses', () => {
    const hash = sha256ContentHash(new Uint8Array([1, 2, 3]));

    expect(parseContentHash(hash)).toEqual({ ok: true, value: hash });
  });

  it('refuses a string where bytes are expected', () => {
    expect(() => sha256ContentHash('abc' as unknown as Uint8Array)).toThrow(TypeError);
  });

  it('wraps the lowercase hex of SubjectKeyService.hmac', () => {
    const hex = 'ab'.repeat(32);

    expect(hmacContentHash(hex)).toBe(`hmac-sha256:${hex}`);
  });

  it.each([['AB'.repeat(32)], ['ab'.repeat(31)], ['ab'.repeat(33)], ['zz'.repeat(32)], ['']])(
    'refuses %s as an hmac',
    (hex) => {
      expect(() => hmacContentHash(hex)).toThrow(TypeError);
    },
  );
});
