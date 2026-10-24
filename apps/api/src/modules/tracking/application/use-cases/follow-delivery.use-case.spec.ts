import { Temporal, type Id } from '@mondapac-drive/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac-drive/shared-kernel/testing';
import { fakeRunOnce } from '../../../../../test/support/fake-run-once';
import { expectSystemOnly, openGate } from '../../../../../test/support/system-only-denial';
import { TEST_MARKETS } from '../../../../../test/support/test-config';
import {
  directUnitOfWork,
  InMemoryTrackingRepository,
  newClock,
} from '../../../../../test/support/tracking-markets';
import { DELIVERY_STATUS_CODES } from '../../../delivery';
import { TRACKED_STATUSES } from '../../domain/tracked-delivery';
import { trackedStatusOf } from '../../presentation/subscribers/delivery-lifecycle.subscriptions';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { DeliveryRoute } from '../../domain/tracked-delivery';
import type { DeliveryRoutes } from '../ports';
import { FollowDelivery, type FollowDeliveryInput } from './follow-delivery.use-case';

const deliveryId = '0195f000-0000-7000-8000-000000000001' as Id<'Delivery'>;
const courier = '01990000-0000-7000-8000-0000000000c1';

let events = 0;
const deliveryOf = (subscriber = 'tracking.delivery-status-changed'): EventDelivery => ({
  eventId: `0195f000-0000-7000-8000-${(++events).toString(16).padStart(12, '0')}` as never,
  subscriber,
  attempt: 1,
});

function setup(route: DeliveryRoute | undefined) {
  const clock = newClock();
  const tracking = new InMemoryTrackingRepository();
  const routes: DeliveryRoutes & { calls: number } = {
    calls: 0,
    routeOf() {
      this.calls += 1;
      return Promise.resolve(route);
    },
  };
  const unitOfWork = { ...directUnitOfWork, runOnce: fakeRunOnce() };
  return {
    clock,
    tracking,
    routes,
    follow: new FollowDelivery(openGate(), { tracking, routes, unitOfWork, clock }),
  };
}

describe.each(TEST_MARKETS)('FollowDelivery in market %s', (code) => {
  const market = testMarketContext(code, 'platform');
  const system = testCallContext(market, 'system', 'tracking-follow-0001');
  // A route inside the Market's own area: Brisbane for AU, Tokyo for the synthetic ZZ.
  const route: DeliveryRoute =
    code === 'AU'
      ? {
          pickup: { lat: -27.47, lng: 153.02 },
          dropoff: { lat: -27.5, lng: 153.05 },
          vehicle: 'bicycle',
        }
      : { pickup: { lat: 35.68, lng: 139.76 }, dropoff: { lat: 35.7, lng: 139.8 }, vehicle: 'van' };
  const input = (
    version: number,
    extra: Partial<FollowDeliveryInput> = {},
  ): FollowDeliveryInput => ({
    delivery: deliveryOf(),
    deliveryId,
    aggregateVersion: version,
    status: 'DISPATCHING',
    ...extra,
  });

  it('starts tracking from booked, reading the route from delivery once', async () => {
    const s = setup(route);
    const booked = await s.follow.execute(system, input(1));
    expect(booked).toMatchObject({
      ok: true,
      value: {
        status: 'DISPATCHING',
        pickup: route.pickup,
        vehicle: route.vehicle,
        deliveryVersion: 1,
      },
    });
    await s.follow.execute(system, input(2, { status: 'ASSIGNED', courierId: courier }));
    expect(s.routes.calls).toBe(1);
    expect(await s.tracking.findDelivery(market, deliveryId)).toMatchObject({
      status: 'ASSIGNED',
      courierId: courier,
      deliveryVersion: 2,
    });
  });

  it('starts from a status change that arrives before booked; the late booked changes nothing', async () => {
    const s = setup(route);
    await s.follow.execute(system, input(2, { status: 'ASSIGNED', courierId: courier }));
    const late = await s.follow.execute(system, input(1));
    expect(late).toMatchObject({ ok: true, value: { status: 'ASSIGNED', courierId: courier } });
  });

  it('ends tracking on cancelled and on DELIVERED', async () => {
    for (const ending of [
      { status: 'CANCELLED' as const },
      { status: 'DELIVERED' as const, courierId: courier },
    ]) {
      const s = setup(route);
      await s.follow.execute(system, input(1));
      const ended = await s.follow.execute(system, input(2, ending));
      expect(ended.ok && ended.value?.endedAt).toEqual(s.clock.now());
      // A later event of an ended delivery is handled and changes nothing.
      const after = await s.follow.execute(system, input(3, { status: 'RETURNING' }));
      expect(after.ok && after.value?.status).toBe(ending.status);
    }
  });

  it('handles one event once', async () => {
    const s = setup(route);
    const once = input(1);
    await s.follow.execute(system, once);
    const again = await s.follow.execute(system, once);
    expect(again).toEqual({ ok: true, value: undefined });
  });

  it('refuses, so the event is retried, while delivery has no route for a new delivery', async () => {
    const s = setup(undefined);
    expect(await s.follow.execute(system, input(1))).toMatchObject({
      ok: false,
      error: { code: 'tracking.delivery-not-found' },
    });
    expect(await s.tracking.findDelivery(market, deliveryId)).toBeUndefined();
  });

  it('refuses a malformed courier id', async () => {
    const s = setup(route);
    expect(await s.follow.execute(system, input(1, { courierId: 'not an id' }))).toMatchObject({
      ok: false,
      error: { code: 'tracking.invalid', field: 'courierId' },
    });
  });

  it('admits the system actor only', async () => {
    const s = setup(route);
    await expectSystemOnly(code, (context) => s.follow.execute(context, input(1)));
  });

  it('uses the clock, never the wall time', async () => {
    const s = setup(route);
    const started = await s.follow.execute(system, input(1));
    expect(started.ok && Temporal.Instant.compare(started.value!.startedAt, s.clock.now())).toBe(0);
  });
});

describe("delivery's event status codes", () => {
  it('map one to one onto the statuses tracking keeps', () => {
    expect(DELIVERY_STATUS_CODES.map(trackedStatusOf)).toEqual([...TRACKED_STATUSES]);
  });
});
