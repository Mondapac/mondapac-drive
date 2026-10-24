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

// The delivery HTTP API's access rules from the security review of WP2 (Hassan), on the real
// application and database for both Market fixtures: only an active courier account is
// assigned; each population sees its own shape of a delivery (no courier id to the merchant, no
// price to the courier); the courier's access ends with the job; free text holds no control or
// bidi character. Its own application, so its requests have their own rate-limit window.

/** A postcode inside an enabled service area of each fixture (config/service-areas). */
const POSTCODE: Readonly<Record<string, string>> = { AU: '4000', ZZ: '1000' };

describe('delivery API access rules (database integration)', () => {
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
    let admin: AdminActor;
    let merchant: MerchantActor;
    let courier: CourierActor;

    beforeAll(async () => {
      const actors = new TestActors(app, code);
      await actors.seedRoles();
      admin = await actors.admin(panelHeaders(code).origin);
      merchant = await actors.merchant(admin, `Merchant ${randomUUID()}`);
      courier = await actors.courier();
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

    it('assigns only an active courier account of the Market (422 otherwise)', async () => {
      const { id, quote } = await book();
      for (const courierId of [admin.accountId, randomUUID()]) {
        const response = await post(
          code,
          `/delivery/admin/deliveries/${id}/dispatch`,
          admin.headers,
          { type: 'courier_assigned', courierId, vehicle: quote.vehicle },
        );
        expect([response.status, response.body]).toEqual([
          422,
          expect.objectContaining({ code: 'delivery.courier-not-active' }),
        ]);
      }
    });

    it('shows the merchant no courier id and the courier no price; the courier loses the job when it ends', async () => {
      const { id, quote } = await book();
      await post(code, `/delivery/admin/deliveries/${id}/dispatch`, admin.headers, {
        type: 'courier_assigned',
        courierId: courier.accountId,
        vehicle: quote.vehicle,
      });

      const asMerchant = await get(code, `/delivery/deliveries/${id}`, merchant.headers);
      expect(asMerchant.body).not.toHaveProperty('courierId');
      expect(JSON.stringify(asMerchant.body)).not.toContain(courier.accountId);
      expect(asMerchant.body).toHaveProperty('quote.total');

      const asCourier = await get(code, `/delivery/courier/deliveries/${id}`, courier.headers);
      expect(asCourier.status).toBe(200);
      const courierQuote = (asCourier.body as { quote: Record<string, unknown> }).quote;
      expect(Object.keys(courierQuote).sort()).toEqual(['distanceMetres', 'vehicle']);
      expect(courierQuote.vehicle).toBe(quote.vehicle);

      const asAdmin = await get(code, `/delivery/admin/deliveries/${id}`, admin.headers);
      expect(asAdmin.body).toMatchObject({ courierId: courier.accountId });
      expect(asAdmin.body).toHaveProperty('quote.total');

      await post(code, `/delivery/admin/deliveries/${id}/cancel`, admin.headers, {
        reason: 'customer cancelled',
      });
      const afterEnd = await get(code, `/delivery/courier/deliveries/${id}`, courier.headers);
      expect(afterEnd.status).toBe(404);
    });

    it('refuses control and bidi characters in free text (400)', async () => {
      for (const text of ['1 Road\u202E', 'Sam\u0007']) {
        const body = booking(code, `order-${randomUUID()}`);
        const response = await post(code, '/delivery/deliveries', merchant.headers, {
          ...body,
          pickup: { ...body.pickup, address: text, contactName: text },
        });
        expect(response.status).toBe(400);
      }
    });
  });
});
