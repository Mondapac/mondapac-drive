import { randomBytes } from 'node:crypto';
import { keyedHash, lengthPrefixed, openField, sealField } from './envelope';
import { SubjectKeyIntegrityError } from './subject-key-service';

// platform-foundations design 4 row 12: AES-256-GCM, 96-bit nonce, 16-byte tag, HKDF-SHA-256
// subkeys, length-prefixed associated data, HMAC-SHA-256, a versioned envelope.

const SUBJECT = '01890a5d-ac96-774b-bcce-b302099a8057';
const OTHER_SUBJECT = '01890a5d-ac96-774b-bcce-b302099a8058';
const FIELD = 'identity.second-factor.secret';

describe.each(['AU', 'ZZ'])('the field envelope in market %s', (marketId) => {
  const dataKey = randomBytes(32);
  const binding = { marketId, subjectId: SUBJECT, field: FIELD };
  const integrity = (reason: string) =>
    expect.objectContaining({ name: 'SubjectKeyIntegrityError', reason }) as unknown;

  it('round-trips, randomised, in a versioned envelope that hides the plaintext', () => {
    const first = sealField(dataKey, binding, 'JBSWY3DPEHPK3PXP');
    const second = sealField(dataKey, binding, 'JBSWY3DPEHPK3PXP');

    expect(first).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain('JBSWY3DPEHPK3PXP');
    expect(openField(dataKey, binding, first)).toBe('JBSWY3DPEHPK3PXP');
    expect(openField(dataKey, binding, sealField(dataKey, binding, ''))).toBe('');
  });

  it.each([
    ['another Market', { ...binding, marketId: marketId === 'AU' ? 'ZZ' : 'AU' }],
    ['another subject', { ...binding, subjectId: OTHER_SUBJECT }],
    ['another field', { ...binding, field: 'identity.account.display-name' }],
  ])('refuses a value moved to %s', (_case, other) => {
    const sealed = sealField(dataKey, binding, 'secret');

    expect(() => openField(dataKey, other, sealed)).toThrow(SubjectKeyIntegrityError);
  });

  it('refuses a value under another data key', () => {
    const sealed = sealField(dataKey, binding, 'secret');

    expect(() => openField(randomBytes(32), binding, sealed)).toThrow(
      integrity('ciphertext-authentication') as Error,
    );
  });

  it('refuses a changed byte, a shortened tag and an unknown format, as integrity failures', () => {
    const sealed = sealField(dataKey, binding, 'secret');
    const bytes = Buffer.from(sealed.slice(3), 'base64url');
    const flipped = Buffer.from(bytes);
    flipped[14] = flipped[14]! ^ 1;
    const shortTag = bytes.subarray(0, bytes.length - 12); // a 4-byte tag (Hassan, PF 10)

    for (const [value, reason] of [
      [`v1.${flipped.toString('base64url')}`, 'ciphertext-authentication'],
      [`v1.${shortTag.toString('base64url')}`, 'ciphertext-authentication'],
      [`v2.${bytes.toString('base64url')}`, 'ciphertext-format'],
      ['v1.', 'ciphertext-format'],
      ['v1.not base64!', 'ciphertext-format'],
      ['plain text', 'ciphertext-format'],
    ] as const) {
      expect(() => openField(dataKey, binding, value)).toThrow(integrity(reason) as Error);
    }
  });

  it('hashes with a key separated by purpose: same input, same subject key, different purposes differ', () => {
    const data = new TextEncoder().encode('ABCD-EFGH');

    const recovery = keyedHash(dataKey, 'identity.recovery-code', data);
    expect(recovery).toMatch(/^[0-9a-f]{64}$/);
    expect(keyedHash(dataKey, 'identity.recovery-code', data)).toBe(recovery);
    expect(keyedHash(dataKey, 'identity.other-purpose', data)).not.toBe(recovery);
    expect(keyedHash(randomBytes(32), 'identity.recovery-code', data)).not.toBe(recovery);
  });
});

describe('lengthPrefixed', () => {
  it('cannot be confused by moving a separator between parts', () => {
    expect(lengthPrefixed(['ab', 'c'])).not.toEqual(lengthPrefixed(['a', 'bc']));
    expect(lengthPrefixed(['a.b'])).not.toEqual(lengthPrefixed(['a', 'b']));
  });
});
