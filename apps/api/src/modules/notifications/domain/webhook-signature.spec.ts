import { Temporal } from '@mondapac-drive/shared-kernel';
import {
  isFresh,
  parseTimestamp,
  SIGNATURE_TOLERANCE_SECONDS,
  signatureDigests,
  signatureHeader,
  signedContent,
  timestampOf,
} from './webhook-signature';

const digest = 'a'.repeat(64);
const other = 'b'.repeat(64);

describe('webhook signature rules', () => {
  it('signs "<timestamp>.<raw body>"', () => {
    expect(signedContent(1793577600, '{"id":"x"}')).toBe('1793577600.{"id":"x"}');
  });

  it('takes whole Unix seconds from the attempt instant', () => {
    expect(timestampOf(Temporal.Instant.from('2026-11-02T00:00:00.999Z'))).toBe(1793577600);
  });

  it('refuses a timestamp that is not positive whole seconds', () => {
    expect(() => signedContent(0, '{}')).toThrow(RangeError);
    expect(() => signedContent(1.5, '{}')).toThrow(RangeError);
  });

  it('writes one v1 entry per digest and reads them back', () => {
    const header = signatureHeader([digest, other]);
    expect(header).toBe(`v1=${digest},v1=${other}`);
    expect(signatureDigests(header)).toEqual([digest, other]);
  });

  it('refuses to write anything but SHA-256 hex digests', () => {
    expect(() => signatureHeader([])).toThrow(RangeError);
    expect(() => signatureHeader(['ABC'])).toThrow(RangeError);
  });

  it('ignores other schemes and malformed parts when reading', () => {
    expect(signatureDigests(`v0=${digest}, v1=xyz, v1=${other}`)).toEqual([other]);
  });

  it('parses only plain positive integer timestamps', () => {
    expect(parseTimestamp('1793577600')).toBe(1793577600);
    expect(parseTimestamp('01793577600')).toBeUndefined();
    expect(parseTimestamp('1793577600.5')).toBeUndefined();
    expect(parseTimestamp('-1')).toBeUndefined();
  });

  it('accepts a timestamp inside the replay window either way, and nothing outside it', () => {
    const now = Temporal.Instant.from('2026-11-02T00:00:00Z');
    const t = timestampOf(now);
    expect(isFresh(t - SIGNATURE_TOLERANCE_SECONDS, now)).toBe(true);
    expect(isFresh(t + SIGNATURE_TOLERANCE_SECONDS, now)).toBe(true);
    expect(isFresh(t - SIGNATURE_TOLERANCE_SECONDS - 1, now)).toBe(false);
    expect(isFresh(t + SIGNATURE_TOLERANCE_SECONDS + 1, now)).toBe(false);
  });
});
