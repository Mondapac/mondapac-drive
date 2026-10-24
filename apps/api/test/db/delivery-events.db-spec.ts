import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ok, Temporal, type Id, type IdGenerator } from '@mondapac-drive/shared-kernel';
import { testCallContext } from '@mondapac-drive/shared-kernel/testing';
import { Client } from 'pg';
import request from 'supertest';
import { DeliveryDispatchView, DeliveryRecipients } from '../../src/modules/delivery';
import {
  DISPATCH_COURIER_ASSIGNED,
  DISPATCH_JOB_EXHAUSTED,
} from '../../src/modules/delivery/presentation/subscribers/dispatch-contract';
import { OUTBOX_RELAY, type OutboxRelay } from '../../src/platform/events/event-bus';
import { EventCatalogue } from '../../src/platform/events/event-catalogue';
import { EVENT_DISPATCHER, type EventDispatcher } from '../../src/platform/events/event-delivery';
import {
  PERMISSION_KEY_LOOKUP,
  type PermissionKeyLookup,
} from '../../src/platform/events/outbox-writer';
import { ID_GENERATOR } from '../../src/platform/ids/ids.module';
import { PrismaOutboxWriterFactory } from '../../src/platform/persistence/outbox/prisma-outbox-writer';
import { PrismaService } from '../../src/platform/persistence/prisma.service';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import { createTestApp } from '../support/test-app';
import { panelHeaders, TEST_MARKETS } from '../support/test-config';
import {
  TestActors,
  type AdminActor,
  type CourierActor,
  type MerchantActor,
} from './actor-support';
import { marketOf, modelMap } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The delivery outbox on the real application and database, for both Market fixtures (handoff
// 21, PR 1): every lifecycle step writes exactly one delivery.* event at the version it made, in
// the unit of the change; a refused step and a repeated booking write none; dispatch's
// courier-assigned and job-exhausted events come back through the delivery inbox once.

const OCCURRED_AT = Temporal.Instant.from('2026-10-26T00:00:00Z');
const POSTCODE: Readonly<Record<string, string>> = { AU: '4000', ZZ: '1000' };

interface OutboxRow {
  readonly type: string;
  readonly aggregate_version: number;
  readonly causation_id: string | null;
  readonly payload: Record<string, unknown>;
}

describe('delivery events (database integration)', () => {
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
  const booking = (code: string, reference: string) => ({
    externalReference: reference,
    pickup: stop(code, -27.47),
    dropoff: stop(code, -27.49),
    parcel: { weightGrams: 2000, volumeLitres: 10, temperature: 'ambient' },
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

  async function outbox(deliveryId: string): Promise<OutboxRow[]> {
    const { rows } = await sql.query<OutboxRow>(
      `SELECT type, aggregate_version, causation_id, payload FROM delivery.outbox
        WHERE aggregate_id = $1 ORDER BY aggregate_version`,
      [deliveryId],
    );
    return rows;
  }

  /** Writes one dispatch event as dispatch's own outbox writer would, then relays and handles it. */
  async function fromDispatch(
    code: string,
    event:
      | ReturnType<typeof DISPATCH_COURIER_ASSIGNED.record>
      | ReturnType<typeof DISPATCH_JOB_EXHAUSTED.record>,
  ): Promise<string> {
    const writer = new PrismaOutboxWriterFactory(
      modelMap,
      app.get(PrismaService),
      app.get(EventCatalogue),
      app.get(ID_GENERATOR),
      app.get<PermissionKeyLookup>(PERMISSION_KEY_LOOKUP),
    ).forModule('dispatch');
    const context = testCallContext(marketOf(code), 'system', `db-test-${randomUUID()}`);
    await app.get<UnitOfWork>(UNIT_OF_WORK).run(context.market, async () => {
      await writer.append(context, [event]);
      return ok(undefined);
    });
    const { rows } = await sql.query<{ event_id: string }>(
      `SELECT event_id FROM dispatch.outbox WHERE correlation_id = $1`,
      [context.correlationId],
    );
    await handleAll();
    return rows[0]!.event_id;
  }

  async function handleAll(): Promise<void> {
    const relay = app.get<OutboxRelay>(OUTBOX_RELAY);
    while ((await relay.runOnce()).published > 0);
    const dispatcher = app.get<EventDispatcher>(EVENT_DISPATCHER);
    while ((await dispatcher.runOnce()).claimed > 0);
  }

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    let admin: AdminActor;
    let merchant: MerchantActor;
    let courier: CourierActor;
    let otherCourier: CourierActor;

    beforeAll(async () => {
      const actors = new TestActors(app, code);
      await actors.seedRoles();
      admin = await actors.admin(panelHeaders(code).origin);
      merchant = await actors.merchant(admin, `Merchant ${randomUUID()}`);
      courier = await actors.courier();
      otherCourier = await actors.courier();
    });

    const book = async (reference = `order-${randomUUID()}`) => {
      const created = await post(
        code,
        '/delivery/deliveries',
        merchant.headers,
        booking(code, reference),
      );
      expect(created.status).toBe(201);
      return created.body as { id: string; merchantId: string; quote: { vehicle: string } };
    };
    const dispatch = (id: string, body: object) =>
      post(code, `/delivery/admin/deliveries/${id}/dispatch`, admin.headers, body);
    const report = (id: string, body: object, by: CourierActor = courier) =>
      post(code, `/delivery/courier/deliveries/${id}/events`, by.headers, body);

    const pinOf = async (id: string) =>
      (await app
        .get(DeliveryRecipients, { strict: false })
        .forNotification(testCallContext(marketOf(code), 'system'), id as Id<'Delivery'>))!
        .recipientPin!;

    it('writes delivery.booked once, and nothing for a repeated booking', async () => {
      const reference = `order-${randomUUID()}`;
      const { id, merchantId, quote } = await book(reference);
      const again = await post(
        code,
        '/delivery/deliveries',
        merchant.headers,
        booking(code, reference),
      );
      expect([again.status, (again.body as { id: string }).id]).toEqual([200, id]);

      expect(await outbox(id)).toEqual([
        {
          type: 'delivery.booked.v1',
          aggregate_version: 1,
          causation_id: null,
          payload: {
            deliveryId: id,
            merchantId,
            status: 'dispatching',
            vehicle: quote.vehicle,
            temperature: 'ambient',
            windowStart: null,
            windowEnd: null,
          },
        },
      ]);
    });

    it('writes one status-changed per step, at the version it made, through to delivered', async () => {
      const { id, quote } = await book();
      expect(
        (
          await dispatch(id, {
            type: 'courier_assigned',
            courierId: courier.accountId,
            vehicle: quote.vehicle,
          })
        ).status,
      ).toBe(200);
      for (const type of ['arrived_at_pickup', 'picked_up', 'arrived_at_dropoff']) {
        expect((await report(id, { type })).status).toBe(200);
      }
      expect(
        (await report(id, { type: 'delivered', proof: { kind: 'pin', pin: await pinOf(id) } }))
          .status,
      ).toBe(200);

      const rows = await outbox(id);
      expect(rows.map((row) => [row.type, row.aggregate_version])).toEqual([
        ['delivery.booked.v1', 1],
        ['delivery.status-changed.v1', 2],
        ['delivery.status-changed.v1', 3],
        ['delivery.status-changed.v1', 4],
        ['delivery.status-changed.v1', 5],
        ['delivery.status-changed.v1', 6],
      ]);
      expect(rows.slice(1).map((row) => row.payload)).toEqual(
        [
          ['dispatching', 'assigned'],
          ['assigned', 'at-pickup'],
          ['at-pickup', 'picked-up'],
          ['picked-up', 'at-dropoff'],
          ['at-dropoff', 'delivered'],
        ].map(([previousStatus, status]) => ({
          deliveryId: id,
          status,
          previousStatus,
          courierId: courier.accountId,
          reason: null,
        })),
      );
    });

    it('writes nothing for a refused step', async () => {
      const { id } = await book();
      expect((await dispatch(id, { type: 'dispatch_opened' })).status).toBe(422);
      expect((await outbox(id)).map((row) => row.type)).toEqual(['delivery.booked.v1']);
    });

    it("codes a dispatcher's unassignment, and a cancel by who cancelled", async () => {
      const first = await book();
      await dispatch(first.id, {
        type: 'courier_assigned',
        courierId: courier.accountId,
        vehicle: first.quote.vehicle,
      });
      await dispatch(first.id, { type: 'courier_unassigned', reason: 'courier unwell' });
      await post(code, `/delivery/deliveries/${first.id}/cancel`, merchant.headers, {
        reason: 'order refunded',
      });
      expect((await outbox(first.id)).slice(2).map((row) => [row.type, row.payload])).toEqual([
        [
          'delivery.status-changed.v1',
          {
            deliveryId: first.id,
            status: 'dispatching',
            previousStatus: 'assigned',
            courierId: null,
            reason: 'dispatcher-unassigned',
          },
        ],
        [
          'delivery.cancelled.v1',
          { deliveryId: first.id, previousStatus: 'dispatching', reason: 'merchant-cancelled' },
        ],
      ]);

      const second = await book();
      await post(code, `/delivery/admin/deliveries/${second.id}/cancel`, admin.headers, {
        reason: 'duplicate',
      });
      expect((await outbox(second.id)).slice(1).map((row) => row.payload)).toEqual([
        { deliveryId: second.id, previousStatus: 'dispatching', reason: 'operator-cancelled' },
      ]);
    });

    const assigned = (deliveryId: string, courierId: string, previous: string | null = null) =>
      DISPATCH_COURIER_ASSIGNED.record({
        aggregateId: app.get<IdGenerator>(ID_GENERATOR).next(),
        aggregateVersion: 2,
        occurredAt: OCCURRED_AT,
        payload: {
          deliveryId: deliveryId as Id,
          courierId: courierId as Id,
          vehicle: 'car',
          method: 'offer',
          previousCourierId: previous as Id | null,
        },
      });

    it("records dispatch's assignment once, a reassignment as two steps, and skips a stale one", async () => {
      const { id } = await book();
      const eventId = await fromDispatch(code, assigned(id, courier.accountId));

      const view = await get(code, `/delivery/admin/deliveries/${id}`, admin.headers);
      expect(view.body).toMatchObject({ status: 'ASSIGNED', courierId: courier.accountId });
      const afterFirst = await outbox(id);
      expect(
        afterFirst
          .slice(1)
          .map((row) => [row.aggregate_version, row.causation_id, row.payload.status]),
      ).toEqual([[2, eventId, 'assigned']]);

      // Redelivered (the inbox) or repeated (same courier): nothing more.
      await handleAll();
      await fromDispatch(code, assigned(id, courier.accountId));
      expect(await outbox(id)).toHaveLength(2);

      // An assignment that does not replace the current courier is older than it: skipped.
      await fromDispatch(code, assigned(id, otherCourier.accountId));
      expect(await outbox(id)).toHaveLength(2);

      await fromDispatch(code, assigned(id, otherCourier.accountId, courier.accountId));
      // The replaced courier's late first assignment does not bring the job back to it.
      await fromDispatch(code, assigned(id, courier.accountId));
      expect((await outbox(id)).slice(2).map((row) => row.payload)).toEqual([
        {
          deliveryId: id,
          status: 'dispatching',
          previousStatus: 'assigned',
          courierId: null,
          reason: 'courier-reassigned',
        },
        {
          deliveryId: id,
          status: 'assigned',
          previousStatus: 'dispatching',
          courierId: otherCourier.accountId,
          reason: null,
        },
      ]);
      const asNewCourier = await get(
        code,
        `/delivery/courier/deliveries/${id}`,
        otherCourier.headers,
      );
      expect(asNewCourier.status).toBe(200);
    });

    it('flags an exhausted job for a dispatcher until it is assigned, with no event', async () => {
      const { id, quote } = await book();
      await fromDispatch(
        code,
        DISPATCH_JOB_EXHAUSTED.record({
          aggregateId: app.get<IdGenerator>(ID_GENERATOR).next(),
          aggregateVersion: 3,
          occurredAt: OCCURRED_AT,
          payload: { deliveryId: id as Id, rounds: 3 },
        }),
      );
      const listed = async () => {
        const page = await get(code, '/delivery/admin/deliveries?limit=100', admin.headers);
        return (page.body as { items: { id: string; exception?: string | null }[] }).items.find(
          (item) => item.id === id,
        );
      };
      expect(await listed()).toMatchObject({
        exception: 'dispatch-exhausted',
        pickupPoint: { lat: -27.47, lng: 153.02 },
        dropoffPoint: { lat: -27.49, lng: 153.02 },
      });
      expect(await outbox(id)).toHaveLength(1);

      await dispatch(id, {
        type: 'courier_assigned',
        courierId: courier.accountId,
        vehicle: quote.vehicle,
      });
      expect(await listed()).toMatchObject({ exception: null });
    });

    it('answers the system reads in the system context only', async () => {
      const { id, merchantId } = await book();
      const system = testCallContext(marketOf(code), 'system');
      const view = app.get(DeliveryDispatchView, { strict: false });
      await expect(view.forDispatch(system, id as Id<'Delivery'>)).resolves.toMatchObject({
        status: 'DISPATCHING',
        pickup: {
          address: '1 Example St',
          postcode: POSTCODE[code],
          point: { lat: -27.47, lng: 153.02 },
        },
        weightGrams: 2000,
        window: undefined,
      });
      await expect(
        view.forDispatch(system, randomUUID() as Id<'Delivery'>),
      ).resolves.toBeUndefined();
      const recipients = app.get(DeliveryRecipients, { strict: false });
      await expect(recipients.forNotification(system, id as Id<'Delivery'>)).resolves.toEqual({
        merchantId,
        externalReference: expect.stringMatching(/^order-/) as unknown,
        dropoffPhone: '+61 400 000 000',
        recipientPin: expect.stringMatching(code === 'AU' ? /^[0-9]{4}$/ : /^[0-9]{6}$/) as unknown,
      });
      const anonymous = testCallContext(marketOf(code), 'anonymous');
      await expect(view.forDispatch(anonymous, id as Id<'Delivery'>)).rejects.toThrow(/refused/);
      await expect(recipients.forNotification(anonymous, id as Id<'Delivery'>)).rejects.toThrow(
        /refused/,
      );
    });
  });
});
