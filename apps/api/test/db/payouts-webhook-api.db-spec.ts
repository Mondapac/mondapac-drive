import { createHmac, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp } from '../support/test-app';
import { TEST_MARKETS } from '../support/test-config';
import { testDatabaseUrl } from './test-database';

// The payment provider's webhook on the real application and database, for both Market
// fixtures: the Market comes from the path, the signature is checked over the exact bytes the
// provider sent (the application keeps the raw body), a redelivery is answered 200 and changes
// nothing, and an unsigned or re-serialised body is refused with 400. The route has its own body
// limit of 512 KB (Hassan L4).

const WEBHOOK_SECRET = 'whsec_apitest0123456789';

describe('payouts provider webhook (database integration)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp({
      env: {
        DATABASE_URL: testDatabaseUrl(),
        HOSTED_MARKETS: TEST_MARKETS.join(','),
        STRIPE_SECRET_KEY: 'sk_test_api0123456789',
        STRIPE_WEBHOOK_SECRETS: WEBHOOK_SECRET,
      },
    }));
  });

  afterAll(async () => {
    await app.close();
  });

  const signature = (body: string, secret = WEBHOOK_SECRET) => {
    const t = Math.floor(Date.now() / 1000);
    return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
  };
  // Spacing a JSON serialiser would not reproduce: the signature must cover these exact bytes.
  const eventBody = (type = 'payout.paid') =>
    `{"id": "evt_${randomUUID().replaceAll('-', '')}",  "type": "${type}", "data": {"object": {"id": "po_1"}}}`;
  const post = (path: string, body: string, header?: string) => {
    const call = request(app.getHttpServer())
      .post(path)
      .set('content-type', 'application/json')
      .send(body);
    return header === undefined ? call : call.set('stripe-signature', header);
  };

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const path = `/payouts/${code}/provider-webhook`;

    it('accepts a signed event once, and a redelivery without acting again', async () => {
      const body = eventBody();
      const header = signature(body);

      const first = await post(path, body, header);
      const again = await post(path, body, header);

      expect(first.status).toBe(200);
      expect(first.body).toEqual({ received: true });
      expect(again.status).toBe(200);
    });

    it('refuses a missing, forged or stale signature with 400', async () => {
      const body = eventBody();
      const stale = `t=${Math.floor(Date.now() / 1000) - 3600},v1=${'0'.repeat(64)}`;

      for (const header of [undefined, signature(body, 'whsec_forger_0123456789'), stale]) {
        const response = await post(path, body, header);
        expect(response.status).toBe(400);
        expect(response.body).toEqual({
          statusCode: 400,
          code: 'payouts.webhook-signature-invalid',
        });
      }
    });

    it('refuses a body that differs from the signed bytes', async () => {
      const body = eventBody();
      const header = signature(body);

      const response = await post(path, JSON.stringify(JSON.parse(body)), header);

      expect(response.status).toBe(400);
    });

    it('takes a signed event larger than the global 64 KB limit, up to its own 512 KB (L4)', async () => {
      // Stripe's account events can exceed the application's limit; the padding is a field the
      // verifier ignores.
      const padded = (bytes: number) =>
        eventBody().replace('{"id": "po_1"}', `{"id": "po_1", "pad": "${'x'.repeat(bytes)}"}`);
      const large = padded(100 * 1024);
      const tooLarge = padded(600 * 1024);

      expect((await post(path, large, signature(large))).status).toBe(200);
      expect((await post(path, tooLarge, signature(tooLarge))).status).toBe(413);
    });
  });

  it('keeps the 64 KB limit for an unhosted Market and any other path or method (L-a)', async () => {
    const body = `{"id": "evt_1", "pad": "${'x'.repeat(100 * 1024)}"}`;
    const server = () => request(app.getHttpServer());

    for (const call of [
      () => server().post('/payouts/QQ/provider-webhook'),
      () => server().post(`/payouts/${TEST_MARKETS[0]}/provider-webhook/x`),
      () => server().put(`/payouts/${TEST_MARKETS[0]}/provider-webhook`),
    ]) {
      const response = await call().set('content-type', 'application/json').send(body);
      expect(response.status).toBe(413);
    }
  });

  it('refuses a Market this deployment does not host, before reading the body', async () => {
    const body = eventBody();

    const response = await post('/payouts/QQ/provider-webhook', body, signature(body));

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });
});
