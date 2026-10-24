import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Clock, Id } from '@mondapac-drive/shared-kernel';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { IssueTrackingLink, RecordLocationPing, TrackDelivery } from '../../src/modules/tracking';
import { CLOCK } from '../../src/platform/clock/clock.module';
import { createTestApp, type LogLine } from '../support/test-app';
import { TEST_MARKETS } from '../support/test-config';
import { marketOf } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The customer tracking link on the real application and database, for both Market fixtures:
// the public read shows only the phase, ETA and courier position from pickup until drop-off,
// nothing after delivery, nothing for another Market; the live channel sends the same view;
// the courier and dispatcher routes are not served before identity's authentication; and no
// coordinate reaches a log line.

const pickup = { lat: -27.47, lng: 153.02 };
const dropoff = { lat: -27.5, lng: 153.05 };

describe('tracking API (database integration)', () => {
  let app: NestExpressApplication;
  let logLines: LogLine[];

  beforeAll(async () => {
    ({ app, logLines } = await createTestApp({
      env: { DATABASE_URL: testDatabaseUrl(), HOSTED_MARKETS: TEST_MARKETS.join(',') },
    }));
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (code: string, path: string) =>
    request(app.getHttpServer()).get(path).set('x-market-id', code);

  /** The first server-sent event of a stream that stays open. */
  function firstEvent(code: string, path: string): Promise<string> {
    const { port } = app.getHttpServer().address() as AddressInfo;
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path,
          headers: { 'x-market-id': code, accept: 'text/event-stream' },
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

    async function trackedLink(status: 'ASSIGNED' | 'PICKED_UP', courierId: string) {
      const deliveryId = randomUUID() as Id<'Delivery'>;
      await app
        .get(TrackDelivery)
        .perform(market, { deliveryId, status, courierId, vehicle, pickup, dropoff });
      const link = await app.get(IssueTrackingLink).perform(market, deliveryId);
      if (!link.ok) throw new Error(link.error.code);
      return { deliveryId, token: link.value.token };
    }

    it('shows the phase, ETA and rounded courier position while the delivery is carried', async () => {
      const courierId = `c-${randomUUID().slice(0, 8)}`;
      const { deliveryId, token } = await trackedLink('ASSIGNED', courierId);
      const ping = await app.get(RecordLocationPing).perform(market, {
        courierId,
        lat: -27.481234567,
        lng: 153.029876543,
        accuracyM: 7,
        recordedAt: app.get<Clock>(CLOCK).now(),
      });
      expect(ping).toMatchObject({ ok: true, value: { breadcrumbs: 1 } });

      const before = await get(code, `/tracking/links/${token}`);
      expect(before.status).toBe(200);
      expect(before.body).toEqual({ phase: 'heading_to_pickup' });
      expect(before.headers['cache-control']).toBe('no-store');

      await app
        .get(TrackDelivery)
        .perform(market, { deliveryId, status: 'PICKED_UP', courierId, vehicle, pickup, dropoff });
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
      const courierId = `c-${randomUUID().slice(0, 8)}`;
      const { deliveryId, token } = await trackedLink('PICKED_UP', courierId);
      await app
        .get(TrackDelivery)
        .perform(market, { deliveryId, status: 'DELIVERED', courierId, vehicle, pickup, dropoff });

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

  it('serves no courier or dispatcher route before authentication exists', async () => {
    const courierPing = await request(app.getHttpServer())
      .post('/tracking/couriers/c-1/pings')
      .set('x-market-id', 'AU')
      .send({ lat: 0, lng: 0, accuracyM: 1, recordedAt: '2026-11-02T00:00:00Z' });
    expect(courierPing.status).toBe(404);
    for (const path of [
      '/tracking/couriers/nearest?lat=0&lng=0&radiusM=10',
      '/tracking/couriers/c-1/position',
      `/tracking/deliveries/${randomUUID()}/trail`,
      '/tracking/map/stream?lat=0&lng=0&radiusM=10',
    ]) {
      expect((await get('AU', path)).status).toBe(404);
    }
  });
});
