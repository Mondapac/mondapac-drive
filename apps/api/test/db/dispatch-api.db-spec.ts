import { randomUUID } from 'node:crypto';
import type { Clock, IdGenerator } from '@mondapac-drive/shared-kernel';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client } from 'pg';
import request from 'supertest';
import {
  DISPATCH_JOB_REPOSITORY,
  DISPATCH_SETTINGS,
  type DispatchJobRepository,
  type DispatchSettingsProvider,
} from '../../src/modules/dispatch/application/ports';
import { openDispatchJob, sendWave, sweep } from '../../src/modules/dispatch/domain/dispatch-job';
import { CLOCK } from '../../src/platform/clock/clock.module';
import { OUTBOX_RELAY, type OutboxRelay } from '../../src/platform/events/event-bus';
import { EVENT_DISPATCHER, type EventDispatcher } from '../../src/platform/events/event-delivery';
import { ID_GENERATOR } from '../../src/platform/ids/ids.module';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import { requirements, stops } from '../support/dispatch-markets';
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

// Dispatch on the real application and database, for both Market fixtures, with real
// credentials: a courier's bearer session sees and answers only its own offers (the courier is
// the session's, never a path or body field, and another courier's offer answers 404 like an
// unknown one); dispatchers view a job, assign or reassign an active courier (audited) and
// restart offering with the admin cookie; an operator without the assign key, a courier and an
// anonymous caller are refused. The delivery lifecycle drives the job through the outbox and
// the event dispatcher: a booking opens it, an unassignment on the delivery's route offers it
// again, and a cancel stops it.

const POSTCODE: Readonly<Record<string, string>> = { AU: '4000', ZZ: '1000' };

describe('dispatch API (database integration)', () => {
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

  const get = (code: string, path: string, headers: object = {}) =>
    request(app.getHttpServer())
      .get(path)
      .set({ 'x-market-id': code, ...headers });
  const post = (code: string, path: string, headers: object, body: object = {}) =>
    request(app.getHttpServer())
      .post(path)
      .set({ 'x-market-id': code, ...headers })
      .send(body);

  async function handleAll(): Promise<void> {
    const relay = app.get<OutboxRelay>(OUTBOX_RELAY);
    const dispatcher = app.get<EventDispatcher>(EVENT_DISPATCHER);
    // Each handled event may publish more (dispatch -> delivery -> dispatch): run until quiet.
    for (let pass = 0; pass < 5; pass += 1) {
      while ((await relay.runOnce()).published > 0);
      let claimed = 0;
      for (
        let batch = await dispatcher.runOnce();
        batch.claimed > 0;
        batch = await dispatcher.runOnce()
      ) {
        claimed += batch.claimed;
      }
      if (claimed === 0) return;
    }
  }

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const market = marketOf(code);
    let dispatcher: AdminActor;
    let operator: AdminActor;
    let courier: CourierActor;
    let otherCourier: CourierActor;

    beforeAll(async () => {
      const actors = new TestActors(app, code);
      await actors.seedRoles();
      dispatcher = await actors.admin(panelHeaders(code).origin, 'dispatcher');
      operator = await actors.admin(panelHeaders(code).origin, 'operator');
      courier = await actors.courier();
      otherCourier = await actors.courier();
    });

    /** A job whose first wave went to `courierIds`, stored as dispatch stores it. */
    async function offeredTo(...couriers: CourierActor[]) {
      const ids = app.get<IdGenerator>(ID_GENERATOR, { strict: false });
      const clock = app.get<Clock>(CLOCK, { strict: false });
      const settings = app
        .get<DispatchSettingsProvider>(DISPATCH_SETTINGS, { strict: false })
        .get(market.marketId);
      const jobs = app.get<DispatchJobRepository>(DISPATCH_JOB_REPOSITORY, { strict: false });
      const now = clock.now();
      const opened = openDispatchJob(
        {
          id: ids.next<'DispatchJob'>(),
          marketId: market.marketId,
          deliveryId: ids.next<'Delivery'>(),
          requirements: requirements(),
          stops: stops(),
          deliveryVersion: 1,
        },
        now,
        settings,
      );
      const wave = sendWave(
        sweep(opened, now, settings).job,
        couriers.map((c, i) => ({
          courierId: c.accountId as string as never,
          vehicle: 'car' as const,
          distanceMetres: 100 * (i + 1),
        })),
        now,
        { ...settings, waveSize: couriers.length },
        () => ids.next<'DispatchOffer'>(),
      ).job;
      const unit = app.get<UnitOfWork>(UNIT_OF_WORK, { strict: false });
      await unit.run(market, async () => {
        await jobs.insert(market, opened);
        await jobs.update(market, wave);
        return { ok: true as const, value: undefined };
      });
      return wave;
    }

    const offerOf = (job: Awaited<ReturnType<typeof offeredTo>>, c: CourierActor) =>
      job.offers.find((o) => o.courierId === (c.accountId as string))!.id;

    it('shows a courier its own offer with both stops, and nothing to another courier', async () => {
      const job = await offeredTo(courier);

      const mine = await get(code, '/dispatch/courier/offers/current', courier.headers);
      expect(mine.status).toBe(200);
      expect(mine.body).toEqual({
        offer: {
          id: offerOf(job, courier),
          deliveryId: job.deliveryId,
          expiresAt: job.offers[0]!.expiresAt.toString(),
          pickup: { address: '1 Pickup Street', point: requirements().pickup },
          dropoff: { address: '2 Dropoff Road', point: stops().dropoff },
          distanceMetres: 4200,
          temperature: 'chilled',
        },
      });
      const theirs = await get(code, '/dispatch/courier/offers/current', otherCourier.headers);
      expect(theirs.body).toEqual({ offer: null });
    });

    it("refuses another courier's offer with 404, then lets its holder accept it", async () => {
      const job = await offeredTo(courier);
      const offerId = offerOf(job, courier);

      const stolen = await post(
        code,
        `/dispatch/courier/offers/${offerId}/accept`,
        otherCourier.headers,
      );
      expect(stolen.status).toBe(404);
      expect((stolen.body as { code: string }).code).toBe('offer.not-found');
      const unknown = await post(code, '/dispatch/courier/offers/nope/accept', courier.headers);
      expect(unknown.status).toBe(404);

      const accepted = await post(
        code,
        `/dispatch/courier/offers/${offerId}/accept`,
        courier.headers,
      );
      expect(accepted.status).toBe(200);
      expect(accepted.body).toEqual({ deliveryId: job.deliveryId });
      const again = await post(code, `/dispatch/courier/offers/${offerId}/accept`, courier.headers);
      expect(again.status).toBe(409);

      const { rows } = await sql.query<{ type: string }>(
        `SELECT type FROM dispatch.outbox WHERE market_id = $1 AND payload->>'deliveryId' = $2
          ORDER BY event_id`,
        [code, job.deliveryId],
      );
      expect(rows.map((row) => row.type)).toContain('dispatch.courier-assigned.v1');
    });

    it('declines with 204 and refuses a body with extra fields', async () => {
      const job = await offeredTo(courier);
      const offerId = offerOf(job, courier);

      const extra = await post(
        code,
        `/dispatch/courier/offers/${offerId}/decline`,
        courier.headers,
        {
          courierId: otherCourier.accountId,
        },
      );
      expect(extra.status).toBe(400);
      const declined = await post(
        code,
        `/dispatch/courier/offers/${offerId}/decline`,
        courier.headers,
      );
      expect(declined.status).toBe(204);
    });

    it('refuses the courier routes without a courier session', async () => {
      const job = await offeredTo(courier);
      const accept = `/dispatch/courier/offers/${offerOf(job, courier)}/accept`;

      expect((await get(code, '/dispatch/courier/offers/current')).status).toBe(401);
      expect((await post(code, accept, {})).status).toBe(401);
      // An admin's cookie is no courier session: its origin is refused, or no session is read.
      expect([401, 403]).toContain(
        (await get(code, '/dispatch/courier/offers/current', dispatcher.headers)).status,
      );
      expect([401, 403]).toContain((await post(code, accept, dispatcher.headers)).status);
    });

    it('lets a dispatcher view the job and assign an active courier, with an audit row', async () => {
      const job = await offeredTo(courier);
      const base = `/dispatch/admin/deliveries/${job.deliveryId}`;

      const viewed = await get(code, base, dispatcher.headers);
      expect(viewed.status).toBe(200);
      expect(viewed.body).toMatchObject({ status: 'OFFERING', assignment: null });
      expect((viewed.body as { offers: unknown[] }).offers).toHaveLength(1);
      expect(JSON.stringify(viewed.body)).not.toContain('Dropoff Road');

      const assigned = await post(code, `${base}/assign`, dispatcher.headers, {
        courierId: otherCourier.accountId,
        vehicle: 'van',
      });
      expect(assigned.status).toBe(200);
      expect((assigned.body as { assignment: unknown }).assignment).toMatchObject({
        courierId: otherCourier.accountId,
        vehicle: 'van',
        method: 'manual',
      });
      const { rows } = await sql.query<{ action: string; actor_id: string }>(
        `SELECT action, actor_id FROM platform.audit_log
          WHERE market_id = $1 AND target_id = $2 ORDER BY occurred_at, id`,
        [code, job.id],
      );
      expect(rows).toEqual([
        { action: 'dispatch.job.courier-assigned', actor_id: dispatcher.accountId },
      ]);

      const notACourier = await post(code, `${base}/assign`, dispatcher.headers, {
        courierId: dispatcher.accountId,
        vehicle: 'car',
      });
      expect(notACourier.status).toBe(422);
      expect((notACourier.body as { code: string }).code).toBe('dispatch.courier-not-active');
      const exhaustedOnly = await post(code, `${base}/redispatch`, dispatcher.headers);
      expect(exhaustedOnly.status).toBe(409);
    });

    it('refuses an operator without the assign key, a courier and an anonymous caller', async () => {
      const job = await offeredTo(courier);
      const base = `/dispatch/admin/deliveries/${job.deliveryId}`;
      const body = { courierId: courier.accountId, vehicle: 'car' };

      expect((await get(code, base, operator.headers)).status).toBe(200);
      expect((await post(code, `${base}/assign`, operator.headers, body)).status).toBe(403);
      expect((await post(code, `${base}/redispatch`, operator.headers)).status).toBe(403);
      expect((await get(code, base)).status).toBe(401);
      expect((await get(code, base, courier.headers)).status).toBe(401);
      // An unsafe admin request without the panel origin is refused before any session is read.
      for (const headers of [{}, courier.headers]) {
        expect([401, 403]).toContain((await post(code, `${base}/assign`, headers, body)).status);
      }
    });

    describe('following the delivery lifecycle', () => {
      let admin: AdminActor;
      let merchant: MerchantActor;

      beforeAll(async () => {
        const actors = new TestActors(app, code);
        admin = await actors.admin(panelHeaders(code).origin);
        merchant = await actors.merchant(admin, `Merchant ${randomUUID()}`);
      });

      const stop = (lat: number, address: string) => ({
        address,
        postcode: POSTCODE[code]!,
        point: { lat, lng: 153.02 },
        contactName: 'Sam',
        contactPhone: '+61 400 000 000',
      });

      async function book(): Promise<string> {
        const created = await post(code, '/delivery/deliveries', merchant.headers, {
          externalReference: `order-${randomUUID()}`,
          pickup: stop(-27.47, '1 Example St'),
          dropoff: stop(-27.49, '9 Recipient Rd'),
          parcel: { weightGrams: 2000, volumeLitres: 10, temperature: 'ambient' },
          mode: 'on_demand',
        });
        expect(created.status).toBe(201);
        await handleAll();
        return (created.body as { id: string }).id;
      }

      // Read from the table, not the route: the routes are covered above, and the rate limit
      // of one test client would otherwise be reached in the second Market.
      const jobOf = async (deliveryId: string) => {
        const { rows } = await sql.query<{
          status: string;
          assigned_courier_id: string | null;
          dropoff_address: string | null;
          excluded_courier_ids: string[];
        }>(
          `SELECT status, assigned_courier_id, dropoff_address, excluded_courier_ids
             FROM dispatch.jobs WHERE market_id = $1 AND delivery_id = $2`,
          [code, deliveryId],
        );
        expect(rows).toHaveLength(1);
        return rows[0]!;
      };

      it('opens a job from the booking, keeps the delivery in step, and stops on a cancel', async () => {
        const deliveryId = await book();
        expect(await jobOf(deliveryId)).toMatchObject({
          status: 'OFFERING',
          dropoff_address: '9 Recipient Rd',
        });

        // A dispatcher assigns through dispatch: the delivery records the courier.
        const assigned = await post(
          code,
          `/dispatch/admin/deliveries/${deliveryId}/assign`,
          dispatcher.headers,
          { courierId: courier.accountId, vehicle: 'van' },
        );
        expect(assigned.status).toBe(200);
        await handleAll();
        const { rows: delivered } = await sql.query<{ status: string; courier_id: string }>(
          'SELECT status, courier_id FROM delivery.deliveries WHERE market_id = $1 AND id = $2',
          [code, deliveryId],
        );
        expect(delivered).toEqual([{ status: 'ASSIGNED', courier_id: courier.accountId }]);

        // The delivery's own unassign: dispatch offers it again, never to that courier.
        const unassigned = await post(
          code,
          `/delivery/admin/deliveries/${deliveryId}/dispatch`,
          dispatcher.headers,
          { type: 'courier_unassigned', reason: 'courier unwell' },
        );
        expect(unassigned.status).toBe(200);
        await handleAll();
        expect(await jobOf(deliveryId)).toMatchObject({
          status: 'OFFERING',
          assigned_courier_id: null,
          excluded_courier_ids: [courier.accountId],
        });

        const cancelled = await post(
          code,
          `/delivery/deliveries/${deliveryId}/cancel`,
          merchant.headers,
          { reason: 'order refunded' },
        );
        expect(cancelled.status).toBe(200);
        await handleAll();
        expect(await jobOf(deliveryId)).toMatchObject({
          status: 'CANCELLED',
          dropoff_address: null,
        });
      });
    });

    it("answers 404 for another Market's job", async () => {
      const job = await offeredTo(courier);
      const other = TEST_MARKETS.find((m) => m !== code)!;
      const actors = new TestActors(app, other);
      await actors.seedRoles();
      const elsewhere = await actors.admin(panelHeaders(other).origin, 'dispatcher');

      const read = await get(
        other,
        `/dispatch/admin/deliveries/${job.deliveryId}`,
        elsewhere.headers,
      );
      expect(read.status).toBe(404);
    });
  });
});
