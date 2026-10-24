import { money } from '@mondapac-drive/shared-kernel';
import { ProviderSecret } from '../../../platform/config/payment-provider';
import {
  StripePayoutGateway,
  type HttpRequest,
  type HttpResponse,
  type HttpTransport,
} from './stripe-payout-gateway';

// The Stripe adapter against a fake transport: what it sends (form fields, the key, the
// idempotency key) and how it reads answers and refusals. No network.

const KEY = 'sk_test_fake0123456789';

function fakeStripe(...answers: (HttpResponse | Error)[]) {
  const sent: HttpRequest[] = [];
  const transport: HttpTransport = (request) => {
    sent.push(request);
    const answer = answers.shift() ?? { status: 500, body: '{}' };
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
  return { sent, gateway: new StripePayoutGateway(new ProviderSecret(KEY), transport) };
}

const json = (status: number, body: unknown): HttpResponse => ({
  status,
  body: JSON.stringify(body),
});
const fields = (request: HttpRequest) => Object.fromEntries(new URLSearchParams(request.body));

describe('StripePayoutGateway', () => {
  it('creates a transfer in minor units with the line’s idempotency key', async () => {
    const { sent, gateway } = fakeStripe(json(200, { id: 'tr_123', object: 'transfer' }));

    const result = await gateway.createTransfer({
      amount: money(1729n, 'AUD'),
      destination: 'acct_1',
      idempotencyKey: 'payout-line-abc',
      metadata: { marketId: 'AU', payoutLineId: 'abc', runId: 'run-1' },
    });

    expect(result).toEqual({ ok: true, value: { transferId: 'tr_123' } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual(
      expect.objectContaining({ method: 'POST', url: 'https://api.stripe.com/v1/transfers' }),
    );
    expect(sent[0]!.headers).toEqual({
      authorization: `Bearer ${KEY}`,
      'content-type': 'application/x-www-form-urlencoded',
      'idempotency-key': 'payout-line-abc',
    });
    expect(fields(sent[0]!)).toEqual({
      amount: '1729',
      currency: 'aud',
      destination: 'acct_1',
      transfer_group: 'run-1',
      'metadata[marketId]': 'AU',
      'metadata[payoutLineId]': 'abc',
      'metadata[runId]': 'run-1',
    });
  });

  it('sends a zero-decimal currency as whole units', async () => {
    const { sent, gateway } = fakeStripe(json(200, { id: 'tr_9' }));

    await gateway.createTransfer({
      amount: money(860n, 'JPY'),
      destination: 'acct_1',
      idempotencyKey: 'payout-line-z',
      metadata: {},
    });

    expect(fields(sent[0]!)).toEqual(expect.objectContaining({ amount: '860', currency: 'jpy' }));
  });

  it('refuses, without a call, a currency Stripe counts differently and a non-positive amount', async () => {
    const { sent, gateway } = fakeStripe();
    const transfer = (amount: bigint, currency: string) =>
      gateway.createTransfer({
        amount: money(amount, currency),
        destination: 'acct_1',
        idempotencyKey: 'k',
        metadata: {},
      });

    expect(await transfer(100n, 'HUF')).toEqual({
      ok: false,
      error: { code: 'stripe.unsupported-amount', transient: false },
    });
    expect((await transfer(0n, 'AUD')).ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it.each([
    [
      json(402, { error: { type: 'invalid_request_error', code: 'balance_insufficient' } }),
      'stripe.balance_insufficient',
      false,
    ],
    [
      json(400, {
        error: { type: 'invalid_request_error', message: 'No such destination: acct_x' },
      }),
      'stripe.invalid_request_error',
      false,
    ],
    [json(429, { error: { type: 'rate_limit_error' } }), 'stripe.rate_limit_error', true],
    [json(400, { error: { type: 'idempotency_error' } }), 'stripe.idempotency_error', true],
    [json(500, { error: { type: 'api_error' } }), 'stripe.api_error', true],
    [{ status: 502, body: '<html>bad gateway</html>' }, 'stripe.unknown', true],
    [new Error('socket hang up'), 'stripe.unreachable', true],
    [json(200, { id: 'not a valid id!' }), 'stripe.malformed-answer', true],
  ])('reads a refusal as its code, never its message (%#)', async (answer, code, transient) => {
    const { gateway } = fakeStripe(answer);

    const result = await gateway.createTransfer({
      amount: money(100n, 'AUD'),
      destination: 'acct_1',
      idempotencyKey: 'k',
      metadata: {},
    });

    expect(result).toEqual({ ok: false, error: { code, transient } });
  });

  it('creates an Express account that can receive transfers, idempotently', async () => {
    const { sent, gateway } = fakeStripe(json(200, { id: 'acct_1ABC', object: 'account' }));

    const result = await gateway.createAccount({
      country: 'AU',
      idempotencyKey: 'payout-account-AU-c-1',
      metadata: { marketId: 'AU', courierId: 'c-1' },
    });

    expect(result).toEqual({ ok: true, value: { accountId: 'acct_1ABC' } });
    expect(sent[0]!.url).toBe('https://api.stripe.com/v1/accounts');
    expect(sent[0]!.headers['idempotency-key']).toBe('payout-account-AU-c-1');
    expect(fields(sent[0]!)).toEqual({
      type: 'express',
      country: 'AU',
      'capabilities[transfers][requested]': 'true',
      'metadata[marketId]': 'AU',
      'metadata[courierId]': 'c-1',
    });
  });

  it('creates an onboarding link and reads its expiry', async () => {
    const { sent, gateway } = fakeStripe(
      json(200, { url: 'https://connect.stripe.com/setup/e/acct_1/abc', expires_at: 1793580000 }),
    );

    const result = await gateway.createOnboardingLink({
      accountId: 'acct_1',
      returnUrl: 'https://drive.example.test/return',
      refreshUrl: 'https://drive.example.test/refresh',
    });

    expect(result.ok && result.value.url).toBe('https://connect.stripe.com/setup/e/acct_1/abc');
    expect(result.ok && result.value.expiresAt.epochMilliseconds).toBe(1793580000_000);
    expect(fields(sent[0]!)).toEqual({
      account: 'acct_1',
      type: 'account_onboarding',
      return_url: 'https://drive.example.test/return',
      refresh_url: 'https://drive.example.test/refresh',
    });
  });

  it('refuses an onboarding link that does not point at Stripe', async () => {
    const { gateway } = fakeStripe(
      json(200, { url: 'https://evil.example/phish', expires_at: 1793580000 }),
    );

    const result = await gateway.createOnboardingLink({
      accountId: 'acct_1',
      returnUrl: 'https://drive.example.test/return',
      refreshUrl: 'https://drive.example.test/refresh',
    });

    expect(result).toEqual({
      ok: false,
      error: { code: 'stripe.malformed-answer', transient: true },
    });
  });

  it('lists every transfer of a run, page by page, with its line', async () => {
    const lineId = '01990000-0000-7000-8000-0000000000aa';
    const transfer = (id: string, payoutLineId?: string) => ({
      id,
      object: 'transfer',
      amount: 1729,
      currency: 'aud',
      destination: 'acct_1',
      metadata: payoutLineId === undefined ? {} : { payoutLineId },
    });
    const { sent, gateway } = fakeStripe(
      json(200, { object: 'list', data: [transfer('tr_1', lineId)], has_more: true }),
      json(200, { object: 'list', data: [transfer('tr_2')], has_more: false }),
    );

    const result = await gateway.transfersOfGroup('run-1');

    expect(result).toEqual({
      ok: true,
      value: [
        {
          transferId: 'tr_1',
          amount: money(1729n, 'AUD'),
          destination: 'acct_1',
          payoutLineId: lineId,
        },
        { transferId: 'tr_2', amount: money(1729n, 'AUD'), destination: 'acct_1' },
      ],
    });
    expect(sent.map((request) => [request.method, request.url, request.body])).toEqual([
      ['GET', 'https://api.stripe.com/v1/transfers?transfer_group=run-1&limit=100', undefined],
      [
        'GET',
        'https://api.stripe.com/v1/transfers?transfer_group=run-1&limit=100&starting_after=tr_1',
        undefined,
      ],
    ]);
    expect(sent[0]!.headers).toEqual({ authorization: `Bearer ${KEY}` });
  });

  it('fails a lookup with a malformed transfer or a refusal, never a partial list', async () => {
    const malformed = fakeStripe(
      json(200, { object: 'list', data: [{ id: 'tr_1', amount: -1 }], has_more: false }),
    );
    const refused = fakeStripe(json(500, { error: { type: 'api_error' } }));

    expect(await malformed.gateway.transfersOfGroup('run-1')).toEqual({
      ok: false,
      error: { code: 'stripe.malformed-answer', transient: true },
    });
    expect(await refused.gateway.transfersOfGroup('run-1')).toEqual({
      ok: false,
      error: { code: 'stripe.api_error', transient: true },
    });
  });
});
