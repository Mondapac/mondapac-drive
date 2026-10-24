import { Temporal } from '@mondapac-drive/shared-kernel';
import { candidateSteps, parseTotpCode, stepIsFresh, timeStepAt, TOTP } from './totp';
import { displayRecoveryCode, parseRecoveryCode, RECOVERY_CODES } from './recovery-code';

const at = (seconds: number) => Temporal.Instant.fromEpochMilliseconds(seconds * 1000);

describe('TOTP step arithmetic (identity design 7.1; RFC 6238)', () => {
  it("uses Hassan's parameters", () => {
    expect(TOTP).toEqual({
      algorithm: 'SHA1',
      digits: 6,
      periodSeconds: 30,
      toleranceSteps: 1,
      secretBytes: 20,
    });
  });

  // The times of the RFC 6238 appendix B table and their T values.
  it.each([
    [59, 1],
    [1111111109, 0x23523ec],
    [1111111111, 0x23523ed],
    [1234567890, 0x273ef07],
    [2000000000, 0x3f940aa],
    [20000000000, 0x27bc86aa],
  ])('step of %i s is %i', (seconds, step) => {
    expect(timeStepAt(at(seconds))).toBe(step);
  });

  it('counts a step from its first second to its last', () => {
    expect(timeStepAt(at(60))).toBe(2);
    expect(timeStepAt(at(89))).toBe(2);
    expect(timeStepAt(Temporal.Instant.fromEpochMilliseconds(89_999))).toBe(2);
    expect(timeStepAt(at(90))).toBe(3);
  });

  it('accepts one step of tolerance each way, the current step first', () => {
    expect(candidateSteps(at(95))).toEqual([3, 2, 4]);
    expect(candidateSteps(at(10))).toEqual([0, 1]);
  });

  it('accepts a step once, never one at or before the last accepted step', () => {
    expect(stepIsFresh(5, null)).toBe(true);
    expect(stepIsFresh(6, 5)).toBe(true);
    expect(stepIsFresh(5, 5)).toBe(false);
    expect(stepIsFresh(4, 5)).toBe(false);
    expect(stepIsFresh(-1, null)).toBe(false);
    expect(stepIsFresh(1.5, null)).toBe(false);
  });

  it.each([
    ['123456', '123456'],
    [' 123456 ', '123456'],
    ['123 456', '123456'],
    ['123-456', '123456'],
    ['12345', null],
    ['1234567', null],
    ['12345a', null],
    ['１２３４５６', null],
    ['12 34 56', null],
    ['', null],
  ])('reads the code %j as %j', (raw, parsed) => {
    expect(parseTotpCode(raw)).toBe(parsed);
  });

  it('refuses what is not a string', () => {
    expect(parseTotpCode(123456)).toBeNull();
    expect(parseTotpCode(null)).toBeNull();
    expect(parseTotpCode('1'.repeat(17))).toBeNull();
  });
});

describe('recovery codes (identity design 7.3; Hassan H2)', () => {
  it('are ten codes of ten Crockford base32 characters', () => {
    expect(RECOVERY_CODES.count).toBe(10);
    expect(RECOVERY_CODES.length).toBe(10);
    expect(RECOVERY_CODES.alphabet).toHaveLength(32);
    expect(RECOVERY_CODES.alphabet).not.toMatch(/[ILOU]/);
  });

  it.each([
    ['ABCDE-FGHJK', 'ABCDEFGHJK'],
    ['abcde fghjk', 'ABCDEFGHJK'],
    [' 0123456789 ', '0123456789'],
    ['oIlL0-ABCDE', '01110ABCDE'],
  ])('reads %j as %j (Crockford decoding)', (raw, canonical) => {
    expect(parseRecoveryCode(raw)).toBe(canonical);
  });

  it.each(['ABCDEFGHJ', 'ABCDEFGHJKM', 'ABCDEFGHJU', 'ABCDE_FGHJ', 'ÄBCDEFGHJK', ''])(
    'refuses %j',
    (raw) => {
      expect(parseRecoveryCode(raw)).toBeNull();
    },
  );

  it('refuses what is not a string or is far too long', () => {
    expect(parseRecoveryCode(1234567890)).toBeNull();
    expect(parseRecoveryCode('A'.repeat(33))).toBeNull();
  });

  it('shows a code in two groups of five, which reads back to the same code', () => {
    const code = parseRecoveryCode('ABCDEFGHJK')!;
    expect(displayRecoveryCode(code)).toBe('ABCDE-FGHJK');
    expect(parseRecoveryCode(displayRecoveryCode(code))).toBe(code);
  });
});
