import { createHmac } from 'node:crypto';
import { Temporal } from '@mondapac-drive/shared-kernel';
import { ProviderSecret } from '../../../platform/config/payment-provider';
import { SIGNATURE_TOLERANCE_SECONDS, StripeWebhookVerifier } from './stripe-webhook-verifier';

// Stripe's signature scheme: `Stripe-Signature: t=<unix seconds>,v1=<hex HMAC-SHA-256 of
// "<t>.<raw body>">`, under the endpoint's signing secret.

const SECRET = 'whsec_test_secret_0123456789';
const ROTATED = 'whsec_new_secret_9876543210';
const now = Temporal.Instant.from('2026-11-02T00:00:00Z');
const t = now.epochMilliseconds / 1000;

const sign = (body: string, timestamp = t, secret = SECRET) =>
  createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
const header = (body: string, timestamp = t, secret = SECRET) =>
  `t=${timestamp},v1=${sign(body, timestamp, secret)}`;

const verifier = new StripeWebhookVerifier([
  new ProviderSecret(SECRET),
  new ProviderSecret(ROTATED),
]);

const event = (type: string, object: Record<string, unknown>) =>
  JSON.stringify({ id: 'evt_1Abc', object: 'event', type, data: { object } });

describe('StripeWebhookVerifier', () => {
  it('accepts a signed account update and reads whether payouts are enabled', () => {
    const body = event('account.updated', {
      id: 'acct_1',
      object: 'account',
      payouts_enabled: true,
    });

    expect(verifier.verify(Buffer.from(body), header(body), now)).toEqual({
      ok: true,
      value: {
        kind: 'account-updated',
        id: 'evt_1Abc',
        type: 'account.updated',
        accountId: 'acct_1',
        payoutsEnabled: true,
      },
    });
  });

  it('reads a transfer reversal as a running total in minor units', () => {
    const body = event('transfer.reversed', {
      id: 'tr_1',
      object: 'transfer',
      amount: 1100,
      amount_reversed: 300,
      currency: 'aud',
    });

    expect(verifier.verify(Buffer.from(body), header(body), now)).toEqual({
      ok: true,
      value: {
        kind: 'transfer-reversed',
        id: 'evt_1Abc',
        type: 'transfer.reversed',
        transferId: 'tr_1',
        amountReversed: 300n,
        currency: 'AUD',
      },
    });
  });

  it('accepts any configured secret (rotation) and any of several v1 signatures', () => {
    const body = event('payout.paid', { id: 'po_1' });
    const both = `t=${t},v1=${'0'.repeat(64)},v1=${sign(body, t, ROTATED)}`;

    expect(verifier.verify(Buffer.from(body), both, now)).toEqual({
      ok: true,
      value: { kind: 'ignored', id: 'evt_1Abc', type: 'payout.paid' },
    });
  });

  it.each([
    ['no header', undefined],
    ['a malformed header', 'v1=abc'],
    ['another secret', header(event('account.updated', {}), t, 'whsec_someone_else_000')],
    [
      'a timestamp too old',
      header(event('account.updated', {}), t - SIGNATURE_TOLERANCE_SECONDS - 1),
    ],
    [
      'a timestamp too far ahead',
      header(event('account.updated', {}), t + SIGNATURE_TOLERANCE_SECONDS + 1),
    ],
    ['a v0 signature only', `t=${t},v0=${sign(event('account.updated', {}))}`],
  ])('refuses %s', (_case, signature) => {
    const body = event('account.updated', {});

    expect(verifier.verify(Buffer.from(body), signature, now)).toEqual({
      ok: false,
      error: 'signature-invalid',
    });
  });

  it('refuses a body changed after signing, even by one byte', () => {
    const body = event('account.updated', { id: 'acct_1', payouts_enabled: false });
    const signature = header(body);

    expect(verifier.verify(Buffer.from(body.replace('false', 'true ')), signature, now).ok).toBe(
      false,
    );
  });

  it('refuses everything when no secret is configured', () => {
    const body = event('account.updated', { id: 'acct_1', payouts_enabled: true });

    expect(new StripeWebhookVerifier([]).verify(Buffer.from(body), header(body), now).ok).toBe(
      false,
    );
  });

  it.each([
    ['not JSON', 'not json'],
    ['no event id', JSON.stringify({ type: 'account.updated', data: { object: {} } })],
    ['an account update without its flag', event('account.updated', { id: 'acct_1' })],
    [
      'a fractional reversal',
      event('transfer.reversed', { id: 'tr_1', amount_reversed: 1.5, currency: 'aud' }),
    ],
  ])('refuses a signed body that is %s', (_case, body) => {
    expect(verifier.verify(Buffer.from(body), header(body), now)).toEqual({
      ok: false,
      error: 'payload-invalid',
    });
  });
});
