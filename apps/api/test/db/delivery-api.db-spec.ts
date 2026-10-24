import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp } from '../support/test-app';
import { panelHeaders, TEST_MARKETS } from '../support/test-config';
import {
  TestActors,
  type AdminActor,
  type CourierActor,
  type MerchantActor,
} from './actor-support';
import { testDatabaseUrl } from './test-database';

// The delivery HTTP API on the real application and database, for both Market fixtures, with
// real credentials: a merchant's API key quotes, books (idempotent on its reference), reads and
// cancels its own deliveries only; an admin dispatches a courier; the assigned courier, and no
// other, reads the delivery and reports on it. No Market reads another's delivery. Amounts
// travel as decimal text in the Market's own currency.

/** A postcode inside an enabled service area of each fixture (config/service-areas). */
const POSTCODE: Readonly<Record<string, string>> = { AU: '4000', ZZ: '1000' };

describe('delivery API (database integration)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    ({ app } = await createTestApp({
      panelOrigins: true,
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
    externalReference: reference,
    pickup: stop(code, -27.47),
    dropoff: stop(code, -27.49),
    parcel,
    mode: 'on_demand',
  });
  const post = (code: string, path: string, headers: object, body: object) =>
    request(app.getHttpServer())
      .post(path)
      .set({ 'x-market-id': code, ...headers })
      .send(body);
  const get = (code: string, path: string, headers: object) =>
    request(app.getHttpServer())
      .get(path)
      .set({ 'x-market-id': code, ...headers });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const other = TEST_MARKETS.find((market) => market !== code)!;
    let admin: AdminActor;
    let merchant: MerchantActor;
    let otherMerchant: MerchantActor;
    let courier: CourierActor;
    let otherCourier: CourierActor;
    let elsewhere: MerchantActor;

    beforeAll(async () => {
      const actors = new TestActors(app, code);
      await actors.seedRoles();
      admin = await actors.admin(panelHeaders(code).origin);
      merchant = await actors.merchant(admin, `Merchant ${randomUUID()}`);
      otherMerchant = await actors.merchant(admin, `Merchant ${randomUUID()}`);
      courier = await actors.courier();
      otherCourier = await actors.courier();
      const otherActors = new TestActors(app, other);
      await otherActors.seedRoles();
      const otherAdmin = await otherActors.admin(panelHeaders(other).origin);
      elsewhere = await otherActors.merchant(otherAdmin, `Merchant ${randomUUID()}`);
    });

    const book = async (by: MerchantActor = merchant) => {
      const created = await post(
        code,
        '/delivery/deliveries',
        by.headers,
        booking(code, `order-${randomUUID()}`),
      );
      expect(created.status).toBe(201);
      return created.body as { id: string; merchantId: string; quote: { vehicle: string } };
    };

    it('books a delivery once, at the quoted price, and answers a retry with the same delivery', async () => {
      const quote = await post(code, '/delivery/quotes', merchant.headers, {
        pickup: { postcode: POSTCODE[code], point: { lat: -27.47, lng: 153.02 } },
        dropoff: { postcode: POSTCODE[code], point: { lat: -27.49, lng: 153.02 } },
        parcel,
        mode: 'on_demand',
      });
      expect(quote.status).toBe(200);
      const total = (quote.body as { total: { amount: string; currency: string } }).total;
      expect(total.amount).toMatch(/^[0-9]+$/);

      const body = { ...booking(code, `order-${randomUUID()}`), expectedTotal: total.amount };
      const created = await post(code, '/delivery/deliveries', merchant.headers, body);
      expect(created.status).toBe(201);
      const delivery = created.body as {
        id: string;
        merchantId: string;
        status: string;
        quote: { total: unknown };
      };
      expect(delivery.status).toBe('DISPATCHING');
      expect(delivery.merchantId).toBe(merchant.merchantId);
      expect(delivery.quote.total).toEqual(total);

      const retried = await post(code, '/delivery/deliveries', merchant.headers, body);
      expect(retried.status).toBe(200);
      expect((retried.body as { id: string }).id).toBe(delivery.id);
    });

    it('answers 503 for a stop given by address when no geocoder is configured', async () => {
      // The test stack sets no routing key: routes are straight-line, geocoding is unavailable.
      const quote = await post(code, '/delivery/quotes', merchant.headers, {
        pickup: { postcode: POSTCODE[code], address: '1 Example Street' },
        dropoff: { postcode: POSTCODE[code], point: { lat: -27.49, lng: 153.02 } },
        parcel,
        mode: 'on_demand',
      });
      expect(quote.status).toBe(503);
      expect((quote.body as { code: string }).code).toBe('address.geocoding-unavailable');

      const neither = await post(code, '/delivery/quotes', merchant.headers, {
        pickup: { postcode: POSTCODE[code] },
        dropoff: { postcode: POSTCODE[code], point: { lat: -27.49, lng: 153.02 } },
        parcel,
        mode: 'on_demand',
      });
      expect(neither.status).toBe(400);
    });

    it('keeps one reference per merchant: another merchant books the same reference anew', async () => {
      const reference = `order-${randomUUID()}`;
      const mine = await post(
        code,
        '/delivery/deliveries',
        merchant.headers,
        booking(code, reference),
      );
      const theirs = await post(
        code,
        '/delivery/deliveries',
        otherMerchant.headers,
        booking(code, reference),
      );

      expect([mine.status, theirs.status]).toEqual([201, 201]);
      expect((theirs.body as { id: string }).id).not.toBe((mine.body as { id: string }).id);
    });

    it('refuses a booking whose expected total is not the current price (409)', async () => {
      const response = await post(code, '/delivery/deliveries', merchant.headers, {
        ...booking(code, `order-${randomUUID()}`),
        expectedTotal: '1',
      });

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ code: 'quote.price-changed' });
    });

    it('refuses a request without a key, a malformed key, a key of another Market and a courier token (401)', async () => {
      const body = booking(code, `order-${randomUUID()}`);
      for (const [headers, refusal] of [
        [{}, 'access.unauthenticated'],
        [{ authorization: 'Bearer ms1_not-a-key' }, 'session.invalid'],
        [elsewhere.headers, 'session.invalid'],
        [courier.headers, 'session.invalid'],
      ] as const) {
        const response = await post(code, '/delivery/deliveries', headers, body);
        expect([response.status, response.body]).toEqual([
          401,
          expect.objectContaining({ code: refusal }),
        ]);
      }
    });

    it("answers another merchant's delivery as a missing one, also for a cancel", async () => {
      const { id } = await book();

      const read = await get(code, `/delivery/deliveries/${id}`, otherMerchant.headers);
      const cancel = await post(code, `/delivery/deliveries/${id}/cancel`, otherMerchant.headers, {
        reason: 'not mine',
      });

      for (const response of [read, cancel]) {
        expect(response.status).toBe(404);
        expect(response.body).toMatchObject({ code: 'delivery.not-found' });
      }
      const own = await get(code, `/delivery/deliveries/${id}`, merchant.headers);
      expect((own.body as { status: string }).status).toBe('DISPATCHING');
    });

    it('lets an admin assign a courier, the courier alone report, and keeps the history', async () => {
      const { id, quote } = await book();

      const assigned = await post(
        code,
        `/delivery/admin/deliveries/${id}/dispatch`,
        admin.headers,
        { type: 'courier_assigned', courierId: courier.accountId, vehicle: quote.vehicle },
      );
      expect(assigned.status).toBe(200);
      expect(assigned.body).toMatchObject({ status: 'ASSIGNED', courierId: courier.accountId });

      // Another courier sees nothing and reports nothing; a merchant key is not a courier.
      for (const headers of [otherCourier.headers]) {
        const read = await get(code, `/delivery/courier/deliveries/${id}`, headers);
        const report = await post(code, `/delivery/courier/deliveries/${id}/events`, headers, {
          type: 'arrived_at_pickup',
        });
        expect([read.status, report.status]).toEqual([404, 404]);
      }
      const asMerchant = await get(code, `/delivery/courier/deliveries/${id}`, merchant.headers);
      expect(asMerchant.status).toBe(401);

      const arrived = await post(
        code,
        `/delivery/courier/deliveries/${id}/events`,
        courier.headers,
        { type: 'arrived_at_pickup' },
      );
      expect(arrived.status).toBe(200);
      // A courier never assigns: the dispatch steps are not in its report body.
      const smuggled = await post(
        code,
        `/delivery/courier/deliveries/${id}/events`,
        courier.headers,
        { type: 'courier_assigned', courierId: otherCourier.accountId },
      );
      expect(smuggled.status).toBe(400);

      const read = await get(code, `/delivery/deliveries/${id}`, merchant.headers);
      expect(read.status).toBe(200);
      expect((read.body as { history: { status: string }[] }).history.map((h) => h.status)).toEqual(
        ['DISPATCHING', 'ASSIGNED', 'AT_PICKUP'],
      );
    });

    it('refuses an unsafe admin request without the CSRF token or the panel origin', async () => {
      const { id } = await book();
      const path = `/delivery/admin/deliveries/${id}/dispatch`;
      const body = { type: 'dispatch_opened' };
      const { 'x-csrf-token': _csrf, ...withoutCsrf } = admin.headers;
      void _csrf;
      const { origin: _origin, ...withoutOrigin } = admin.headers;
      void _origin;

      for (const headers of [withoutCsrf, withoutOrigin]) {
        const response = await post(code, path, headers, body);
        expect(response.status).toBe(403);
      }
    });

    it('answers a delivery of this Market as missing in the other Market', async () => {
      const { id } = await book();

      const response = await get(other, `/delivery/deliveries/${id}`, elsewhere.headers);

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ code: 'delivery.not-found' });
    });

    it('refuses an invalid body with the fields at fault (400)', async () => {
      const response = await post(code, '/delivery/deliveries', merchant.headers, {
        externalReference: '',
      });

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({ code: 'validation.failed' });
    });
  });
});
