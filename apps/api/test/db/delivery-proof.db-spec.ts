import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Id } from '@mondapac-drive/shared-kernel';
import { testCallContext } from '@mondapac-drive/shared-kernel/testing';
import { Client } from 'pg';
import request from 'supertest';
import { DeliveryRecipients } from '../../src/modules/delivery';
import { RATE_LIMIT_COUNTERS } from '../../src/platform/rate-limit/rate-limit-counters';
import { createTestApp } from '../support/test-app';
import { panelHeaders, TEST_MARKETS } from '../support/test-config';
import {
  TestActors,
  type AdminActor,
  type CourierActor,
  type MerchantActor,
} from './actor-support';
import { marketOf } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Proof of delivery the server checks (handoff 21, PR 2), on the real application and database
// for both Market fixtures: the recipient's PIN (AU 4 digits and 5 attempts, ZZ 6 digits and 3)
// is compared by the server and never stored; wrong PINs lock the PIN after the Market's limit;
// a proof photo is uploaded by the delivery's courier only, sniffed, size-capped, stored under a
// key that is never returned, and `delivered` takes only a photo of its own delivery.

const POSTCODE: Readonly<Record<string, string>> = { AU: '4000', ZZ: '1000' };
const LIMITS: Readonly<Record<string, { pin: number; attempts: number }>> = {
  AU: { pin: 4, attempts: 5 },
  ZZ: { pin: 6, attempts: 3 },
};
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(200, 2),
]);

describe('proof of delivery (database integration)', () => {
  let app: NestExpressApplication;
  let sql: Client;
  const storeDir = mkdtempSync(path.join(tmpdir(), 'drive-proof-'));

  beforeAll(async () => {
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });

  afterAll(async () => {
    await sql.end();
    rmSync(storeDir, { recursive: true, force: true });
  });

  const server = () => app.getHttpServer() as Parameters<typeof request>[0];
  const post = (code: string, url: string, headers: object, body: object) =>
    request(server())
      .post(url)
      .set({ 'x-market-id': code, ...headers })
      .send(body);

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    let admin: AdminActor;
    let merchant: MerchantActor;
    let courier: CourierActor;
    let otherCourier: CourierActor;
    const limits = LIMITS[code]!;

    // One application per Market. The per-origin limiter is not under test here and every request
    // comes from one address, so its counters never pass the limit (ZZ allows 60 a minute).
    beforeAll(async () => {
      ({ app } = await createTestApp({
        panelOrigins: true,
        override: (builder) =>
          builder.overrideProvider(RATE_LIMIT_COUNTERS).useValue({
            consume: () => Promise.resolve({ count: 1, msBeforeNext: 60_000 }),
          }),
        env: {
          DATABASE_URL: testDatabaseUrl(),
          HOSTED_MARKETS: TEST_MARKETS.join(','),
          OBJECT_STORE_DIR: storeDir,
        },
      }));
      const actors = new TestActors(app, code);
      await actors.seedRoles();
      admin = await actors.admin(panelHeaders(code).origin);
      merchant = await actors.merchant(admin, `Merchant ${randomUUID()}`);
      courier = await actors.courier();
      otherCourier = await actors.courier();
    });

    afterAll(async () => {
      await app.close();
    });

    const stop = (lat: number) => ({
      address: '1 Example St',
      postcode: POSTCODE[code]!,
      point: { lat, lng: 153.02 },
      contactName: 'Sam',
      contactPhone: '+61 400 000 000',
    });

    /** A delivery assigned to `courier` and brought to `steps` (by default the drop-off). */
    async function delivery(
      steps = ['arrived_at_pickup', 'picked_up', 'arrived_at_dropoff'],
      temperature: 'ambient' | 'chilled' = 'ambient',
    ): Promise<string> {
      const created = await post(code, '/delivery/deliveries', merchant.headers, {
        externalReference: `order-${randomUUID()}`,
        pickup: stop(-27.47),
        dropoff: stop(-27.49),
        parcel: { weightGrams: 2000, volumeLitres: 10, temperature },
        mode: 'on_demand',
      });
      const { id, quote } = created.body as { id: string; quote: { vehicle: string } };
      await post(code, `/delivery/admin/deliveries/${id}/dispatch`, admin.headers, {
        type: 'courier_assigned',
        courierId: courier.accountId,
        vehicle: quote.vehicle,
      });
      const reading = temperature === 'ambient' ? {} : { temperatureCelsius: 2 };
      for (const type of steps) await report(id, { type, ...reading });
      return id;
    }
    const report = (id: string, body: object, by: CourierActor = courier) =>
      post(code, `/delivery/courier/deliveries/${id}/events`, by.headers, body);
    const pinOf = async (id: string) =>
      (await app
        .get(DeliveryRecipients, { strict: false })
        .forNotification(testCallContext(marketOf(code), 'system'), id as Id<'Delivery'>))!
        .recipientPin;
    const upload = (id: string, bytes: Buffer, by: CourierActor = courier, name = 'photo') =>
      request(server())
        .post(`/delivery/courier/deliveries/${id}/proof-photos`)
        .set({ 'x-market-id': code, ...by.headers })
        .attach(name, bytes, { filename: 'door.jpg', contentType: 'image/jpeg' });
    const wrongOf = (pin: string) => pin.replace(/^./, (digit) => String((Number(digit) + 1) % 10));

    it("delivers with the recipient's PIN, and stores only that it matched", async () => {
      const id = await delivery();
      const pin = (await pinOf(id))!;
      expect(pin).toMatch(new RegExp(`^[0-9]{${limits.pin}}$`));

      const done = await report(id, { type: 'delivered', proof: { kind: 'pin', pin } });
      expect(done.status).toBe(200);
      const { rows } = await sql.query<{ proof: unknown }>(
        `SELECT proof FROM delivery.delivery_events WHERE delivery_id = $1 AND type = 'delivered'`,
        [id],
      );
      expect(rows).toEqual([{ proof: { kind: 'pin' } }]);
      const events = await sql.query<{ payload: unknown }>(
        'SELECT payload FROM delivery.outbox WHERE aggregate_id = $1',
        [id],
      );
      expect(JSON.stringify(events.rows)).not.toMatch(new RegExp(`"(pin|${pin})"`));
      expect(await pinOf(id)).toBeNull();
    });

    it("locks the PIN after the Market's wrong attempts; a photo still proves the delivery", async () => {
      const id = await delivery();
      const pin = (await pinOf(id))!;
      for (let attempt = 1; attempt <= limits.attempts; attempt += 1) {
        const wrong = await report(id, {
          type: 'delivered',
          proof: { kind: 'pin', pin: wrongOf(pin) },
        });
        expect([wrong.status, (wrong.body as { code: string }).code]).toEqual(
          attempt < limits.attempts ? [422, 'delivery.pin-wrong'] : [423, 'delivery.pin-locked'],
        );
      }
      const right = await report(id, { type: 'delivered', proof: { kind: 'pin', pin } });
      expect([right.status, (right.body as { code: string }).code]).toEqual([
        423,
        'delivery.pin-locked',
      ]);

      const photo = await upload(id, JPEG);
      expect(photo.status).toBe(201);
      const { photoRef } = photo.body as { photoRef: string };
      const done = await report(id, { type: 'delivered', proof: { kind: 'photo', photoRef } });
      expect(done.status).toBe(200);
    });

    it('takes no attempt for a PIN offered before the drop-off', async () => {
      const id = await delivery(['arrived_at_pickup', 'picked_up']);
      const early = await report(id, { type: 'delivered', proof: { kind: 'pin', pin: '0000' } });
      expect([early.status, (early.body as { code: string }).code]).toEqual([
        422,
        'delivery.invalid-transition',
      ]);
      const { rows } = await sql.query<{ wrong_pins: number }>(
        'SELECT wrong_pins FROM delivery.deliveries WHERE id = $1',
        [id],
      );
      expect(rows).toEqual([{ wrong_pins: 0 }]);
    });

    it('tells a right PIN from a wrong one only by using an attempt', async () => {
      const id = await delivery(undefined, 'chilled');
      const pin = (await pinOf(id))!;
      // The step's other rules come first: no reading, refused before the PIN is compared.
      const unread = await report(id, { type: 'delivered', proof: { kind: 'pin', pin } });
      expect([unread.status, (unread.body as { code: string }).code]).toEqual([
        422,
        'cold-chain.reading-required',
      ]);
      const { rows } = await sql.query<{ wrong_pins: number }>(
        'SELECT wrong_pins FROM delivery.deliveries WHERE id = $1',
        [id],
      );
      expect(rows).toEqual([{ wrong_pins: 0 }]);
      const done = await report(id, {
        type: 'delivered',
        temperatureCelsius: 2,
        proof: { kind: 'pin', pin },
      });
      expect(done.status).toBe(200);
    });

    it('buffers no photo for a caller who has not signed in', async () => {
      const id = await delivery(['arrived_at_pickup', 'picked_up']);
      const anonymous = await request(server())
        .post(`/delivery/courier/deliveries/${id}/proof-photos`)
        .set({ 'x-market-id': code })
        .attach('photo', JPEG, { filename: 'door.jpg', contentType: 'image/jpeg' });
      expect([anonymous.status, (anonymous.body as { code: string }).code]).toEqual([
        401,
        'access.unauthenticated',
      ]);
    });

    it('stores a photo for the courier of the delivery only, and never returns its key', async () => {
      const id = await delivery(['arrived_at_pickup', 'picked_up']);
      expect((await upload(id, JPEG, otherCourier)).status).toBe(404);

      const stored = await upload(id, PNG);
      expect(stored.status).toBe(201);
      expect(Object.keys(stored.body as object)).toEqual(['photoRef']);
      const { photoRef } = stored.body as { photoRef: string };
      const { rows } = await sql.query<{ storage_key: string; media_type: string }>(
        'SELECT storage_key, media_type FROM delivery.proof_photos WHERE id = $1',
        [photoRef],
      );
      expect(rows).toEqual([
        { storage_key: `delivery/${code}/${id}/${photoRef}`, media_type: 'image/png' },
      ]);
      expect(readdirSync(path.join(storeDir, 'delivery', code, id))).toEqual([photoRef]);
    });

    it('refuses a photo that is not a JPEG or PNG, too large, missing, or before pickup', async () => {
      const early = await delivery(['arrived_at_pickup']);
      expect((await upload(early, JPEG)).status).toBe(404);

      const id = await delivery();
      const text = await upload(id, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'));
      expect([text.status, (text.body as { code: string }).code]).toEqual([
        415,
        'proof-photo.unsupported-type',
      ]);
      expect((await upload(id, Buffer.concat([JPEG, Buffer.alloc(5 * 1024 * 1024)]))).status).toBe(
        413,
      );
      expect((await upload(id, JPEG, courier, 'file')).status).toBe(400);
      const { rows } = await sql.query(
        'SELECT 1 FROM delivery.proof_photos WHERE delivery_id = $1',
        [id],
      );
      expect(rows).toHaveLength(0);
    });

    it("refuses a photo reference that is not one of this delivery's", async () => {
      const other = await delivery();
      const { photoRef } = (await upload(other, JPEG)).body as { photoRef: string };
      const id = await delivery();
      for (const ref of [photoRef, randomUUID()]) {
        const response = await report(id, {
          type: 'delivered',
          proof: { kind: 'photo', photoRef: ref },
        });
        expect([response.status, (response.body as { code: string }).code]).toEqual([
          422,
          'delivery.proof-photo-unknown',
        ]);
      }
    });
  });
});
