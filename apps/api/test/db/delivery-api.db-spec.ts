import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp } from '../support/test-app';
import { TEST_MARKETS } from '../support/test-config';
import { testDatabaseUrl } from './test-database';

// The delivery HTTP API on the real application and database, for both Market fixtures: quote,
// book (idempotent on the merchant reference), read, record events, and no Market reads
// another's delivery. Amounts travel as decimal text in the Market's own currency.

/** A postcode inside an enabled service area of each fixture (config/service-areas). */
const POSTCODE: Readonly<Record<string, string>> = { AU: '4000', ZZ: '1000' };

describe('delivery API (database integration)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp({
      env: { DATABASE_URL: testDatabaseUrl(), HOSTED_MARKETS: TEST_MARKETS.join(',') },
    }));
  });

  afterAll(async () => {
    await app.close();
  });

  const stop = (code: string, lat: number) => ({
    address: '1 Example St',
    postcode: POSTCODE[code]!,
    point: { lat, lng: 153.02 },
    contactName: 'Sam',
    contactPhone: '+61 400 000 000',
  });
  const parcel = { weightGrams: 2000, volumeLitres: 10, temperature: 'ambient' };
  const booking = (code: string, reference: string) => ({
    merchantId: 'merchant-1',
    externalReference: reference,
    pickup: stop(code, -27.47),
    dropoff: stop(code, -27.49),
    parcel,
    mode: 'on_demand',
  });
  const post = (code: string, path: string, body: object) =>
    request(app.getHttpServer()).post(path).set('x-market-id', code).send(body);
  const get = (code: string, path: string) =>
    request(app.getHttpServer()).get(path).set('x-market-id', code);

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const other = TEST_MARKETS.find((market) => market !== code)!;

    it('books a delivery once, at the quoted price, and answers a retry with the same delivery', async () => {
      const quote = await post(code, '/delivery/quotes', {
        pickup: { postcode: POSTCODE[code], point: { lat: -27.47, lng: 153.02 } },
        dropoff: { postcode: POSTCODE[code], point: { lat: -27.49, lng: 153.02 } },
        parcel,
        mode: 'on_demand',
      });
      expect(quote.status).toBe(200);
      const total = (quote.body as { total: { amount: string; currency: string } }).total;
      expect(total.amount).toMatch(/^[0-9]+$/);

      const body = { ...booking(code, `order-${randomUUID()}`), expectedTotal: total.amount };
      const created = await post(code, '/delivery/deliveries', body);
      expect(created.status).toBe(201);
      const delivery = created.body as { id: string; status: string; quote: { total: unknown } };
      expect(delivery.status).toBe('DISPATCHING');
      expect(delivery.quote.total).toEqual(total);

      const retried = await post(code, '/delivery/deliveries', body);
      expect(retried.status).toBe(200);
      expect((retried.body as { id: string }).id).toBe(delivery.id);
    });

    it('refuses a booking whose expected total is not the current price (409)', async () => {
      const response = await post(code, '/delivery/deliveries', {
        ...booking(code, `order-${randomUUID()}`),
        expectedTotal: '1',
      });

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code: 'quote.price-changed' });
    });

    it("records a courier's events and keeps the history; the other Market sees nothing", async () => {
      const created = await post(
        code,
        '/delivery/deliveries',
        booking(code, `order-${randomUUID()}`),
      );
      const { id, quote } = created.body as { id: string; quote: { vehicle: string } };

      const assigned = await post(code, `/delivery/deliveries/${id}/events`, {
        type: 'courier_assigned',
        courierId: 'courier-1',
        vehicle: quote.vehicle,
      });
      expect(assigned.status).toBe(200);
      expect(assigned.body).toMatchObject({ status: 'ASSIGNED', courierId: 'courier-1' });

      const read = await get(code, `/delivery/deliveries/${id}`);
      expect(read.status).toBe(200);
      expect((read.body as { history: { status: string }[] }).history.map((h) => h.status)).toEqual(
        ['DISPATCHING', 'ASSIGNED'],
      );

      const elsewhere = await get(other, `/delivery/deliveries/${id}`);
      expect(elsewhere.status).toBe(404);
      expect(elsewhere.body).toMatchObject({ code: 'delivery.not-found' });
    });

    it('refuses an invalid body with the fields at fault (400)', async () => {
      const response = await post(code, '/delivery/deliveries', { merchantId: '' });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: 'validation.failed' });
    });
  });
});
