import { randomUUID } from 'node:crypto';
import type { Clock } from '@mondapac-drive/shared-kernel';
import { testCallContext } from '@mondapac-drive/shared-kernel/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client } from 'pg';
import request from 'supertest';
import { DeliveryRecipients } from '../../src/modules/delivery';
import { FleetDirectory } from '../../src/modules/fleet';
import { requirementApplies } from '../../src/modules/fleet/domain/documents';
import { CLOCK } from '../../src/platform/clock/clock.module';
import { OUTBOX_RELAY, type OutboxRelay } from '../../src/platform/events/event-bus';
import { EVENT_DISPATCHER, type EventDispatcher } from '../../src/platform/events/event-delivery';
import { MemoryObjectStore } from '../../src/platform/storage/disk-object-store';
import { OBJECT_STORE } from '../../src/platform/storage/object-store';
import {
  RATE_LIMIT_COUNTERS,
  type RateLimitCounters,
} from '../../src/platform/rate-limit/rate-limit-counters';
import { fleetRules, TEST_SERVICE_AREAS } from '../support/fleet-markets';
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

// Fleet follows the deliveries couriers carry, on the real application and database, for both
// Market fixtures (handoff 31): an assignment gives the courier their active delivery, which
// `GET me` and `PUT me/shift` answer, keeps them out of dispatch's pool and stops them going
// offline (409); delivered, an unassign and a cancel free them again. Each event is handled once
// through fleet's inbox.

const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n');
const POSTCODE: Readonly<Record<string, string>> = { AU: '4000', ZZ: '1000' };

/** The flow sends more requests than ZZ's per-minute limit; the limiter has its own suites. */
const unlimited: RateLimitCounters = {
  consume: () => Promise.resolve({ count: 1, msBeforeNext: 60_000 }),
};

interface JobRow {
  readonly courier_account_id: string | null;
  readonly ended: boolean;
  readonly delivery_version: number;
}

describe('fleet follows the jobs couriers carry (database integration)', () => {
  let app: NestExpressApplication;
  let sql: Client;

  beforeAll(async () => {
    ({ app } = await createTestApp({
      panelOrigins: true,
      env: { DATABASE_URL: testDatabaseUrl(), HOSTED_MARKETS: TEST_MARKETS.join(',') },
      override: (builder) =>
        builder
          .overrideProvider(OBJECT_STORE)
          .useValue(new MemoryObjectStore(() => app.get<Clock>(CLOCK).now()))
          .overrideProvider(RATE_LIMIT_COUNTERS)
          .useValue(unlimited),
    }));
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });

  afterAll(async () => {
    await sql.end();
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  async function handleAll(): Promise<void> {
    const relay = app.get<OutboxRelay>(OUTBOX_RELAY);
    while ((await relay.runOnce()).published > 0);
    const dispatcher = app.get<EventDispatcher>(EVENT_DISPATCHER);
    while ((await dispatcher.runOnce()).claimed > 0);
  }

  async function job(deliveryId: string): Promise<JobRow | undefined> {
    const { rows } = await sql.query<JobRow>(
      `SELECT courier_account_id, ended, delivery_version FROM fleet.courier_jobs
        WHERE delivery_id = $1`,
      [deliveryId],
    );
    return rows[0];
  }

  /**
   * Handles events until fleet applied delivery `version`. Other spec files run their own relay
   * and dispatcher on the same database at the same time, and may hold a claim on one of this
   * spec's events while this one already finds nothing to do.
   */
  async function handleUntil(deliveryId: string, version: number): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await handleAll();
      if ((await job(deliveryId))?.delivery_version === version) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async function handled(deliveryId: string): Promise<string[]> {
    const { rows } = await sql.query<{ handler: string }>(
      `SELECT i.handler FROM fleet.inbox i
         JOIN delivery.outbox o ON o.event_id = i.event_id
        WHERE o.aggregate_id = $1 ORDER BY o.aggregate_version`,
      [deliveryId],
    );
    return rows.map((row) => row.handler);
  }

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const market = marketOf(code);
    const rules = fleetRules.get(market.marketId);
    const area = TEST_SERVICE_AREAS[code]!;
    const system = () => testCallContext(market, 'system', `fleet-jobs-${randomUUID()}`);
    const as = (headers: object) => ({ 'x-market-id': code, ...headers });
    let admin: AdminActor;
    let merchant: MerchantActor;
    let courier: CourierActor;

    /** Takes the courier from application to online: a van, its documents verified, approved. */
    async function onlineCourier(actor: CourierActor): Promise<void> {
      const expiresAt = app
        .get<Clock>(CLOCK)
        .now()
        .add({ hours: 24 * 365 })
        .toString();
      const applied = await http()
        .post('/fleet/courier/me')
        .set(as(actor.headers))
        .send({ employmentType: 'contractor', serviceAreaCode: area, coldChainCapable: false });
      expect(applied.status).toBe(201);
      const courierId = (applied.body as { id: string }).id;
      const withVan = await http()
        .post('/fleet/courier/me/vehicles')
        .set(as(actor.headers))
        .send({ type: 'van', plate: 'JOB 001', coldBox: 'none' });
      expect(withVan.status).toBe(201);
      const van = (withVan.body as { vehicles: { id: string }[] }).vehicles[0]!;
      const vehicle = { id: van.id, type: 'van', coldBox: 'none', active: true };
      for (const requirement of rules.documents) {
        if (!requirementApplies(requirement, 'contractor', vehicle as never, false)) continue;
        let upload = http().post('/fleet/courier/me/documents').set(as(actor.headers));
        upload = upload.field('type', requirement.type);
        if (requirement.perVehicle) upload = upload.field('vehicleId', van.id);
        if (requirement.expires) upload = upload.field('expiresAt', expiresAt);
        const sent = await upload.attach('file', PDF, {
          filename: 'scan.pdf',
          contentType: 'application/pdf',
        });
        expect(sent.status).toBe(201);
      }
      const base = `/fleet/admin/couriers/${courierId}`;
      const detail = await http().get(base).set(as(admin.headers));
      for (const document of (
        detail.body as { documents: { id: string; expiresAt: string | null }[] }
      ).documents) {
        const verified = await http()
          .post(`${base}/documents/${document.id}/verify`)
          .set(as(admin.headers))
          .send(document.expiresAt === null ? {} : { expiresAt });
        expect(verified.status).toBe(200);
      }
      const approved = await http()
        .post(`${base}/approve`)
        .set(as(admin.headers))
        .send({ employmentType: 'contractor', coldChainCapable: false });
      expect(approved.status).toBe(200);
      await shift('online', 200);
    }

    const shift = async (state: string, status: number) => {
      const changed = await http()
        .put('/fleet/courier/me/shift')
        .set(as(courier.headers))
        .send({ state });
      expect(changed.status).toBe(status);
      return changed.body as { shift?: string; activeDeliveryId?: string | null; code?: string };
    };
    const activeDelivery = async () => {
      const me = await http().get('/fleet/courier/me').set(as(courier.headers));
      expect(me.status).toBe(200);
      return (me.body as { activeDeliveryId: string | null }).activeDeliveryId;
    };
    const available = async () =>
      (
        await app.get(FleetDirectory).findAvailableCouriers(system(), {
          vehicleTypes: ['van'],
          coldChain: false,
          serviceArea: area,
        })
      ).some((candidate) => candidate.courierId === courier.accountId);

    const stop = (lat: number) => ({
      address: '1 Example St',
      postcode: POSTCODE[code]!,
      point: { lat, lng: 153.02 },
      contactName: 'Sam',
      contactPhone: '+61 400 000 000',
    });
    const book = async () => {
      const created = await http()
        .post('/delivery/deliveries')
        .set(as(merchant.headers))
        .send({
          externalReference: `order-${randomUUID()}`,
          pickup: stop(-27.47),
          dropoff: stop(-27.49),
          parcel: { weightGrams: 2000, volumeLitres: 10, temperature: 'ambient' },
          mode: 'on_demand',
        });
      expect(created.status).toBe(201);
      return created.body as { id: string; quote: { vehicle: string } };
    };
    const dispatch = (id: string, body: object) =>
      http().post(`/delivery/admin/deliveries/${id}/dispatch`).set(as(admin.headers)).send(body);
    const report = (id: string, body: object) =>
      http().post(`/delivery/courier/deliveries/${id}/events`).set(as(courier.headers)).send(body);

    beforeAll(async () => {
      const actors = new TestActors(app, code);
      await actors.seedRoles();
      admin = await actors.admin(panelHeaders(code).origin);
      merchant = await actors.merchant(admin, `Merchant ${randomUUID()}`);
      courier = await actors.courier();
      await onlineCourier(courier);
    });

    it('gives the courier the job from assignment to DELIVERED, then frees them', async () => {
      expect(await activeDelivery()).toBeNull();
      expect(await available()).toBe(true);

      const { id, quote } = await book();
      const assigned = await dispatch(id, {
        type: 'courier_assigned',
        courierId: courier.accountId,
        vehicle: quote.vehicle,
      });
      expect(assigned.status).toBe(200);
      await handleUntil(id, 2);
      expect(await job(id)).toEqual({
        courier_account_id: courier.accountId,
        ended: false,
        delivery_version: 2,
      });

      expect(await activeDelivery()).toBe(id);
      expect(await shift('offline', 409)).toMatchObject({ code: 'fleet.shift.active-delivery' });
      expect(await shift('paused', 200)).toEqual({ shift: 'paused', activeDeliveryId: id });
      expect(await shift('online', 200)).toEqual({ shift: 'online', activeDeliveryId: id });
      expect(await available()).toBe(false);

      for (const type of ['arrived_at_pickup', 'picked_up', 'arrived_at_dropoff']) {
        expect((await report(id, { type })).status).toBe(200);
      }
      const recipients = await app
        .get(DeliveryRecipients, { strict: false })
        .forNotification(system(), id as never);
      const pin = recipients!.recipientPin!;
      expect((await report(id, { type: 'delivered', proof: { kind: 'pin', pin } })).status).toBe(
        200,
      );
      await handleUntil(id, 6);
      expect(await job(id)).toEqual({ courier_account_id: null, ended: true, delivery_version: 6 });

      expect(await activeDelivery()).toBeNull();
      expect(await available()).toBe(true);
      // Every status change from the assignment on was handled once; handling again changes
      // nothing (booking, version 1, is not followed).
      const handlers = await handled(id);
      expect(handlers).toEqual(Array<string>(5).fill('fleet.follow-delivery-status'));
      await handleAll();
      expect(await handled(id)).toHaveLength(handlers.length);
    });

    it('frees the courier when a dispatcher unassigns, and ends the job at a cancel', async () => {
      const { id, quote } = await book();
      await dispatch(id, {
        type: 'courier_assigned',
        courierId: courier.accountId,
        vehicle: quote.vehicle,
      });
      await handleUntil(id, 2);
      expect(await activeDelivery()).toBe(id);

      await dispatch(id, { type: 'courier_unassigned', reason: 'courier unwell' });
      await handleUntil(id, 3);
      expect(await job(id)).toEqual({
        courier_account_id: null,
        ended: false,
        delivery_version: 3,
      });
      expect(await activeDelivery()).toBeNull();

      await dispatch(id, {
        type: 'courier_assigned',
        courierId: courier.accountId,
        vehicle: quote.vehicle,
      });
      await handleUntil(id, 4);
      expect(await activeDelivery()).toBe(id);

      const cancelled = await http()
        .post(`/delivery/deliveries/${id}/cancel`)
        .set(as(merchant.headers))
        .send({ reason: 'order refunded' });
      expect(cancelled.status).toBe(200);
      await handleUntil(id, 5);
      expect(await job(id)).toEqual({ courier_account_id: null, ended: true, delivery_version: 5 });
      expect(await activeDelivery()).toBeNull();
      expect((await handled(id)).at(-1)).toBe('fleet.follow-delivery-cancelled');

      // Free again, the courier may end the shift.
      expect(await shift('offline', 200)).toEqual({ shift: 'offline', activeDeliveryId: null });
    });
  });
});
