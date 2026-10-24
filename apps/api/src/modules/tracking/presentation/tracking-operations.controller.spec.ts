import { ok, type CallContext } from '@mondapac-drive/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac-drive/shared-kernel/testing';
import { lastValueFrom, toArray } from 'rxjs';
import type { DeliveryTrail } from '../application/use-cases/delivery-trail.use-case';
import type {
  ViewCourierPosition,
  ViewNearbyCouriers,
} from '../application/use-cases/view-courier-positions.use-case';
import { DispatcherTrackingController } from './tracking-operations.controller';

// The dispatcher map's stream slots (security review of 06b, M1): a client that leaves while the
// first read runs, before Nest subscribes, never keeps a slot.

const market = testMarketContext('ZZ', 'platform');
const admin: CallContext = testCallContext(
  market,
  testAuthenticatedActor(market, {
    population: 'admin',
    accountId: '01990000-0000-7000-8000-0000000000a1' as never,
    sessionId: '01990000-0000-7000-8000-0000000001a1' as never,
    merchantId: null,
  }),
  'map-stream-0001',
);
const query = { lat: '-27.47', lng: '153.02', radiusM: '5000' };

function controller() {
  const nearby = { execute: () => Promise.resolve(ok([])) } as unknown as ViewNearbyCouriers;
  return new DispatcherTrackingController(nearby, {} as ViewCourierPosition, {} as DeliveryTrail);
}

describe('dispatcher map stream slots', () => {
  it('gives the slot back when the client left during the first read', async () => {
    const map = controller();
    for (let i = 0; i < 5; i += 1) {
      const gone = new AbortController();
      gone.abort();
      const stream = await map.map(admin, query, gone.signal);
      expect(await lastValueFrom(stream.pipe(toArray()))).toEqual([]);
    }
    // Still the three slots of the admin: a live client opens a stream.
    const live = new AbortController();
    await expect(map.map(admin, query, live.signal)).resolves.toBeDefined();
    live.abort();
  });

  it('refuses a fourth open stream of one admin, and frees a slot on abort', async () => {
    const map = controller();
    const open = [new AbortController(), new AbortController(), new AbortController()];
    for (const client of open) await map.map(admin, query, client.signal);
    await expect(map.map(admin, query, new AbortController().signal)).rejects.toMatchObject({
      status: 429,
    });
    open[0]!.abort();
    await expect(map.map(admin, query, new AbortController().signal)).resolves.toBeDefined();
    for (const client of open) client.abort();
  });
});
