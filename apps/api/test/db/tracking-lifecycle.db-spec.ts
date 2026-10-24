import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { testCallContext } from '@mondapac-drive/shared-kernel/testing';
import { Client } from 'pg';
import request from 'supertest';
import { IssueTrackingLink } from '../../src/modules/tracking';
import { OUTBOX_RELAY, type OutboxRelay } from '../../src/platform/events/event-bus';
import { EVENT_DISPATCHER, type EventDispatcher } from '../../src/platform/events/event-delivery';
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

// Tracking follows the delivery lifecycle on the real application and database, for both Market
// fixtures (handoff 26): delivery.booked starts tracking with delivery's route, each
// status-changed moves the status and the courier, DELIVERED and cancelled end it (the link then
// answers 410), and every event is handled once through tracking's inbox.

const POSTCODE: Readonly<Record<string, string>> = { AU: '4000', ZZ: '1000' };

interface TrackedRow {
  readonly status: string;
  readonly courier_id: string | null;
  readonly vehicle: string | null;
  readonly pickup_lat: number;
  readonly ended: boolean;
  readonly delivery_version: number | null;
}

describe('tracking follows the delivery lifecycle (database integration)', () => {
  let app: NestExpressApplication;
  let sql: Client;

  beforeAll(async () => {
    ({ app } = await createTestApp({
      panelOrigins: true,
      env: { DATABASE_URL: testDatabaseUrl(), HOSTED_MARKETS: TEST_MARKETS.join(',') },
    }));
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });

  afterAll(async () => {
    await sql.end();
    await app.close();
  });

  const stop = (code: string, lat: number) => ({
    address: '1 Example St',
    postcode: POSTCODE[code]!,
    point: { lat, lng: 153.02 },
    contactName: 'Sam',
    contactPhone: '+61 400 000 000',
  });
  const post = (code: string, path: string, headers: object, body: object) =>
    request(app.getHttpServer())
      .post(path)
      .set({ 'x-market-id': code, ...headers })
      .send(body);

  async function handleAll(): Promise<void> {
    const relay = app.get<OutboxRelay>(OUTBOX_RELAY);
    while ((await relay.runOnce()).published > 0);
    const dispatcher = app.get<EventDispatcher>(EVENT_DISPATCHER);
    while ((await dispatcher.runOnce()).claimed > 0);
  }

  async function tracked(deliveryId: string): Promise<TrackedRow | undefined> {
    const { rows } = await sql.query<TrackedRow>(
      `SELECT status, courier_id, vehicle, pickup_lat, ended_at IS NOT NULL AS ended,
              delivery_version
         FROM tracking.tracked_deliveries WHERE delivery_id = $1`,
      [deliveryId],
    );
    return rows[0];
  }

  async function handled(deliveryId: string): Promise<string[]> {
    const { rows } = await sql.query<{ handler: string }>(
      `SELECT i.handler FROM tracking.inbox i
         JOIN delivery.outbox o ON o.event_id = i.event_id
        WHERE o.aggregate_id = $1 ORDER BY o.aggregate_version`,
      [deliveryId],
    );
    return rows.map((row) => row.handler);
  }

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    let admin: AdminActor;
    let merchant: MerchantActor;
    let courier: CourierActor;
    const system = () => testCallContext(marketOf(code), 'system', `tracking-life-${randomUUID()}`);

    beforeAll(async () => {
      const actors = new TestActors(app, code);
      await actors.seedRoles();
      admin = await actors.admin(panelHeaders(code).origin);
      merchant = await actors.merchant(admin, `Merchant ${randomUUID()}`);
      courier = await actors.courier();
    });

    const book = async () => {
      const created = await post(code, '/delivery/deliveries', merchant.headers, {
        externalReference: `order-${randomUUID()}`,
        pickup: stop(code, -27.47),
        dropoff: stop(code, -27.49),
        parcel: { weightGrams: 2000, volumeLitres: 10, temperature: 'ambient' },
        mode: 'on_demand',
      });
      expect(created.status).toBe(201);
      return created.body as { id: string; quote: { vehicle: string } };
    };
    const report = (id: string, body: object) =>
      post(code, `/delivery/courier/deliveries/${id}/events`, courier.headers, body);

    it('starts at booking, follows each step with its courier, and ends at DELIVERED', async () => {
      const { id, quote } = await book();
      await handleAll();
      expect(await tracked(id)).toEqual({
        status: 'DISPATCHING',
        courier_id: null,
        vehicle: quote.vehicle,
        pickup_lat: -27.47,
        ended: false,
        delivery_version: 1,
      });
      const link = await app.get(IssueTrackingLink).execute(system(), { deliveryId: id as never });
      if (!link.ok) throw new Error(link.error.code);

      await post(code, `/delivery/admin/deliveries/${id}/dispatch`, admin.headers, {
        type: 'courier_assigned',
        courierId: courier.accountId,
        vehicle: quote.vehicle,
      });
      for (const type of ['arrived_at_pickup', 'picked_up']) {
        expect((await report(id, { type })).status).toBe(200);
      }
      await handleAll();
      expect(await tracked(id)).toMatchObject({
        status: 'PICKED_UP',
        courier_id: courier.accountId,
        ended: false,
        delivery_version: 4,
      });

      await report(id, { type: 'arrived_at_dropoff' });
      await report(id, { type: 'delivered', proof: { kind: 'photo', photoRef: 'p-1' } });
      await handleAll();
      expect(await tracked(id)).toMatchObject({ status: 'DELIVERED', ended: true });
      const ended = await request(app.getHttpServer())
        .get(`/tracking/links/${link.value.token}`)
        .set('x-market-id', code);
      expect([ended.status, ended.body.code]).toEqual([410, 'tracking.ended']);

      // Each of the six events was handled once; handling again changes nothing.
      expect(await handled(id)).toEqual([
        'tracking.delivery-booked',
        ...Array<string>(5).fill('tracking.delivery-status-changed'),
      ]);
      await handleAll();
      expect(await handled(id)).toHaveLength(6);
    });

    it('drops the courier when a dispatcher unassigns, and ends at a cancel', async () => {
      const { id, quote } = await book();
      await post(code, `/delivery/admin/deliveries/${id}/dispatch`, admin.headers, {
        type: 'courier_assigned',
        courierId: courier.accountId,
        vehicle: quote.vehicle,
      });
      await post(code, `/delivery/admin/deliveries/${id}/dispatch`, admin.headers, {
        type: 'courier_unassigned',
        reason: 'courier unwell',
      });
      await handleAll();
      expect(await tracked(id)).toMatchObject({ status: 'DISPATCHING', courier_id: null });

      await post(code, `/delivery/deliveries/${id}/cancel`, merchant.headers, {
        reason: 'order refunded',
      });
      await handleAll();
      expect(await tracked(id)).toMatchObject({
        status: 'CANCELLED',
        ended: true,
        delivery_version: 4,
      });
      expect((await handled(id)).at(-1)).toBe('tracking.delivery-cancelled');
    });
  });
});
