import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Clock, IdGenerator } from '@mondapac-drive/shared-kernel';
import { testCallContext } from '@mondapac-drive/shared-kernel/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import {
  IssueTrackingLink,
  TrackDelivery,
  type TrackDeliveryInput,
} from '../../src/modules/tracking';
import { CLOCK } from '../../src/platform/clock/clock.module';
import { ID_GENERATOR } from '../../src/platform/ids/ids.module';
import { createTestApp, type LogLine } from '../support/test-app';
import { panelHeaders, TEST_MARKETS } from '../support/test-config';
import { TestActors, type AdminActor, type CourierActor } from './actor-support';
import { marketOf } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Tracking on the real application and database, for both Market fixtures, with real
// credentials: a courier's bearer session sends its own pings (the courier is the session's,
// never a body field); operators and dispatchers read the live map, a courier's position and a
// delivery's trail with the admin cookie; no other population reaches either. The public
// customer link shows only the phase, ETA and courier position from pickup until drop-off,
// nothing after delivery, nothing for another Market; the live channels send the same views;
// and no coordinate reaches a log line.

const pickup = { lat: -27.47, lng: 153.02 };
const dropoff = { lat: -27.5, lng: 153.05 };

describe('tracking API (database integration)', () => {
  let app: NestExpressApplication;
  let logLines: LogLine[];

  beforeAll(async () => {
    ({ app, logLines } = await createTestApp({
      panelOrigins: true,
      env: { DATABASE_URL: testDatabaseUrl(), HOSTED_MARKETS: TEST_MARKETS.join(',') },
    }));
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (code: string, path: string, headers: object = {}) =>
    request(app.getHttpServer())
      .get(path)
      .set({ 'x-market-id': code, ...headers });
  const post = (code: string, path: string, headers: object, body: object) =>
    request(app.getHttpServer())
      .post(path)
      .set({ 'x-market-id': code, ...headers })
      .send(body);

  /** The first server-sent event of a stream that stays open. */
  function firstEvent(
    code: string,
    path: string,
    headers: Readonly<Record<string, string>> = {},
  ): Promise<string> {
    const { port } = app.getHttpServer().address() as AddressInfo;
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path,
          headers: { 'x-market-id': code, accept: 'text/event-stream', ...headers },
        },
        (res) => {
          res.setEncoding('utf8');
          let text = '';
          res.on('data', (chunk: string) => {
            text += chunk;
            if (text.includes('\n\n')) {
              req.destroy();
              resolve(text);
            }
          });
        },
      );
      req.on('error', (error) =>
        error.message.includes('socket hang up') ? undefined : reject(error),
      );
      req.end();
    });
  }

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const market = marketOf(code);
    const other = TEST_MARKETS.find((m) => m !== code)!;
    const vehicle = code === 'ZZ' ? 'van' : 'car';
    const system = () => testCallContext(market, 'system', `tracking-api-${randomUUID()}`);
    let admin: AdminActor;
    let courier: CourierActor;
    let otherCourier: CourierActor;
    let carrier: CourierActor;
    let elsewhere: AdminActor;

    beforeAll(async () => {
      const actors = new TestActors(app, code);
      await actors.seedRoles();
      admin = await actors.admin(panelHeaders(code).origin);
      courier = await actors.courier();
      otherCourier = await actors.courier();
      carrier = await actors.courier();
      const otherActors = new TestActors(app, other);
      await otherActors.seedRoles();
      elsewhere = await otherActors.admin(panelHeaders(other).origin);
    });

    const track = async (input: Omit<TrackDeliveryInput, 'vehicle' | 'pickup' | 'dropoff'>) => {
      const tracked = await app
        .get(TrackDelivery)
        .execute(system(), { ...input, vehicle, pickup, dropoff });
      if (!tracked.ok) throw new Error(tracked.error.code);
    };

    async function trackedLink(status: 'ASSIGNED' | 'PICKED_UP', courierId: string) {
      const deliveryId = app.get<IdGenerator>(ID_GENERATOR, { strict: false }).next<'Delivery'>();
      await track({ deliveryId, status, courierId });
      const link = await app.get(IssueTrackingLink).execute(system(), { deliveryId });
      if (!link.ok) throw new Error(link.error.code);
      return { deliveryId, token: link.value.token };
    }

    const fix = (lat: number, extra: object = {}) => ({
      lat,
      lng: 153.029876543,
      accuracyM: 7,
      recordedAt: app.get<Clock>(CLOCK).now().toString(),
      ...extra,
    });
    const nearest = '/tracking/admin/couriers/nearest?lat=-27.48&lng=153.03&radiusM=5000';

    it("records the signed-in courier's pings, whatever courier id the body names", async () => {
      const { deliveryId } = await trackedLink('ASSIGNED', courier.accountId);
      const sent = await post(code, '/tracking/courier/pings', courier.headers, {
        pings: [fix(-27.481234567, { courierId: otherCourier.accountId })],
      });
      expect(sent.status).toBe(202);
      expect(sent.body).toEqual({ accepted: 1, rejected: [], latest: true, breadcrumbs: 1 });

      const mine = await get(
        code,
        `/tracking/admin/couriers/${courier.accountId}/position`,
        admin.headers,
      );
      expect(mine.status).toBe(200);
      expect(mine.body).toMatchObject({ courierId: courier.accountId, lat: -27.481234567 });
      const theirs = await get(
        code,
        `/tracking/admin/couriers/${otherCourier.accountId}/position`,
        admin.headers,
      );
      expect(theirs.status).toBe(404);

      const map = await get(code, nearest, admin.headers);
      expect(map.status).toBe(200);
      const ids = (map.body as { couriers: { courierId: string }[] }).couriers.map(
        (c) => c.courierId,
      );
      expect(ids).toContain(courier.accountId);

      const trail = await get(
        code,
        `/tracking/admin/deliveries/${deliveryId}/trail`,
        admin.headers,
      );
      expect(trail.status).toBe(200);
      expect(trail.body).toMatchObject({ points: [{ courierId: courier.accountId }] });

      const event = await firstEvent(
        code,
        '/tracking/admin/map/stream?lat=-27.48&lng=153.03&radiusM=5000',
        admin.headers,
      );
      expect(event).toContain('event: couriers');
      expect(event).toContain(courier.accountId);

      // Throttled per courier, and nothing of it for another Market's dispatcher.
      const again = await post(code, '/tracking/courier/pings', courier.headers, {
        pings: [fix(-27.4813)],
      });
      expect(again.status).toBe(429);
      expect(again.body).toMatchObject({ code: 'ping.throttled' });
      const abroad = await get(
        other,
        `/tracking/admin/couriers/${courier.accountId}/position`,
        elsewhere.headers,
      );
      expect(abroad.status).toBe(404);
      expect(JSON.stringify(logLines)).not.toMatch(/-27\.48|153\.029/);
    });

    it('refuses pings without a courier session and dispatcher routes without an admin one', async () => {
      const body = { pings: [fix(-27.47)] };
      expect((await post(code, '/tracking/courier/pings', {}, body)).status).toBe(401);
      // An admin's cookie is no courier session: its origin is refused, or no session is read.
      expect([401, 403]).toContain(
        (await post(code, '/tracking/courier/pings', admin.headers, body)).status,
      );
      expect(
        (await post(code, '/tracking/courier/pings', courier.headers, { ...body, extra: 1 }))
          .status,
      ).toBe(400);
      for (const path of [
        nearest,
        `/tracking/admin/couriers/${courier.accountId}/position`,
        `/tracking/admin/deliveries/${randomUUID()}/trail`,
        '/tracking/admin/map/stream?lat=0&lng=0&radiusM=10',
      ]) {
        expect({ path, status: (await get(code, path)).status }).toEqual({ path, status: 401 });
        const byCourier = await get(code, path, courier.headers);
        expect({ path, status: byCourier.status }).toEqual({ path, status: 401 });
      }
      // The routes served before identity are gone.
      expect((await get(code, '/tracking/couriers/nearest?lat=0&lng=0&radiusM=10')).status).toBe(
        404,
      );
    });

    it('shows the phase, ETA and rounded courier position while the delivery is carried', async () => {
      const courierId = carrier.accountId;
      const { deliveryId, token } = await trackedLink('ASSIGNED', courierId);
      const ping = await post(code, '/tracking/courier/pings', carrier.headers, {
        pings: [fix(-27.481234567)],
      });
      expect(ping.status).toBe(202);
      expect(ping.body).toMatchObject({ breadcrumbs: 1 });

      const before = await get(code, `/tracking/links/${token}`);
      expect(before.status).toBe(200);
      expect(before.body).toEqual({ phase: 'heading_to_pickup' });
      expect(before.headers['cache-control']).toBe('no-store');

      await track({ deliveryId, status: 'PICKED_UP', courierId });
      const during = await get(code, `/tracking/links/${token}`);
      expect(during.status).toBe(200);
      expect(during.body).toEqual({
        phase: 'on_the_way',
        etaSeconds: expect.any(Number) as number,
        courier: { lat: -27.4812, lng: 153.0299, recordedAt: expect.any(String) as string },
      });
      expect(JSON.stringify(during.body)).not.toContain(courierId);

      const event = await firstEvent(code, `/tracking/links/${token}/stream`);
      expect(event).toContain('event: view');
      expect(event).toContain('"phase":"on_the_way"');

      // Nothing for another Market, and no coordinate in any log line.
      expect((await get(other, `/tracking/links/${token}`)).status).toBe(404);
      expect(JSON.stringify(logLines)).not.toMatch(/-27\.48|153\.029/);
    });

    it('answers 410 and nothing else once the delivery is delivered, on both routes', async () => {
      const courierId = otherCourier.accountId;
      const { deliveryId, token } = await trackedLink('PICKED_UP', courierId);
      await track({ deliveryId, status: 'DELIVERED', courierId });

      const after = await get(code, `/tracking/links/${token}`);
      expect(after.status).toBe(410);
      expect(after.body).toEqual({
        statusCode: 410,
        code: 'tracking.ended',
        details: { message: expect.any(String) as string },
      });

      const stream = await get(code, `/tracking/links/${token}/stream`);
      expect(stream.text).toContain('event: end');
      expect(stream.text).toContain('"code":"tracking.ended"');
      expect(stream.text).not.toContain('event: view');
    });

    it('answers 404 for a malformed or unknown token', async () => {
      expect((await get(code, '/tracking/links/not-a-token')).status).toBe(404);
      expect((await get(code, `/tracking/links/${'A'.repeat(43)}`)).body).toMatchObject({
        code: 'tracking.link-not-found',
      });
    });
  });
});
