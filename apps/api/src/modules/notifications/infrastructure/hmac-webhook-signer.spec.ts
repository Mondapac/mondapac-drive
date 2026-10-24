import { createHmac } from 'node:crypto';
import { Temporal } from '@mondapac-drive/shared-kernel';
import { signatureHeader, signedContent, timestampOf } from '../domain/webhook-signature';
import { HmacWebhookSigner, verifyWebhookSignature } from './hmac-webhook-signer';

const key = new Uint8Array(32).fill(7);
const signer = new HmacWebhookSigner(key);
const now = Temporal.Instant.from('2026-11-02T00:00:00Z');
const body = '{"id":"e1","type":"delivery.booked"}';

describe('HMAC webhook signer', () => {
  it('derives a stable secret per subscription and version, never the same for two', () => {
    const secret = signer.secretFor('s1', 1);
    expect(secret).toBe(signer.secretFor('s1', 1));
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(signer.secretFor('s1', 2)).not.toBe(secret);
    expect(signer.secretFor('s2', 1)).not.toBe(secret);
    expect(new HmacWebhookSigner(new Uint8Array(32).fill(8)).secretFor('s1', 1)).not.toBe(secret);
  });

  it('signs HMAC-SHA256 of "<timestamp>.<body>" with the derived secret, as lowercase hex', () => {
    const content = signedContent(timestampOf(now), body);
    const expected = createHmac('sha256', signer.secretFor('s1', 1)).update(content).digest('hex');
    expect(signer.sign('s1', 1, content)).toBe(expected);
  });

  it('refuses a secret version below one', () => {
    expect(() => signer.secretFor('s1', 0)).toThrow(RangeError);
  });
});

describe('receiver check (reference for the marketplace)', () => {
  const secret = signer.secretFor('s1', 1);
  const timestamp = timestampOf(now);
  const header = signatureHeader([signer.sign('s1', 1, signedContent(timestamp, body))]);
  const check = (overrides: Partial<Parameters<typeof verifyWebhookSignature>[0]>) =>
    verifyWebhookSignature({
      secret,
      timestampHeader: String(timestamp),
      signatureHeader: header,
      rawBody: body,
      now,
      ...overrides,
    });

  it('accepts what the signer sent', () => {
    expect(check({})).toBe(true);
  });

  it('accepts when any v1 entry matches, so a receiver survives a rotation', () => {
    expect(check({ signatureHeader: `v1=${'0'.repeat(64)},${header}` })).toBe(true);
  });

  it.each([
    ['a changed body', { rawBody: `${body} ` }],
    ['another secret', { secret: signer.secretFor('s1', 2) }],
    ['a changed timestamp', { timestampHeader: String(timestamp + 1) }],
    ['a stale timestamp', { now: now.add({ minutes: 6 }) }],
    ['a timestamp from the future', { now: now.subtract({ minutes: 6 }) }],
    ['a malformed timestamp', { timestampHeader: 'yesterday' }],
    ['no v1 entry', { signatureHeader: 'v0=abc' }],
  ])('refuses %s', (_name, overrides) => {
    expect(check(overrides)).toBe(false);
  });
});
