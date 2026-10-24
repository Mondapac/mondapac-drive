import { Temporal, type Id } from '@mondapac-drive/shared-kernel';
import { testMarketContext } from '@mondapac-drive/shared-kernel/testing';
import {
  directUnitOfWork,
  InMemoryTrackingRepository,
  fakeRouting,
  newClock,
  trackingSettings,
} from '../../../../../test/support/tracking-markets';
import { TEST_MARKETS } from '../../../../../test/support/test-config';
import { CryptoTrackingTokens } from '../../infrastructure/crypto-tracking-tokens';
import { InMemoryLivePositionStore } from '../../infrastructure/in-memory-live-position-store';
import { RoutingEtaProvider } from '../../infrastructure/routing-eta.provider';
import { IssueTrackingLink } from './issue-tracking-link.use-case';
import { LastKnownPosition } from './last-known-position.use-case';
import { NearestCouriers } from './nearest-couriers.use-case';
import { PurgeTrackingData } from './purge-tracking-data.use-case';
import { RecordLocationPing } from './record-location-ping.use-case';
import { TrackDelivery } from './track-delivery.use-case';
import { ViewTrackingLink } from './view-tracking-link.use-case';

const deliveryId = '0195f000-0000-7000-8000-000000000001' as Id<'Delivery'>;
const pickup = { lat: -27.47, lng: 153.02 };
const dropoff = { lat: -27.5, lng: 153.05 };

function setup() {
  const clock = newClock();
  const positions = new InMemoryLivePositionStore(clock);
  const repository = new InMemoryTrackingRepository();
  const tokens = new CryptoTrackingTokens();
  const eta = new RoutingEtaProvider(fakeRouting(), trackingSettings, clock);
  return {
    clock,
    positions,
    repository,
    record: new RecordLocationPing(
      positions,
      repository,
      trackingSettings,
      directUnitOfWork,
      clock,
    ),
    track: new TrackDelivery(repository, directUnitOfWork, clock),
    issue: new IssueTrackingLink(repository, trackingSettings, tokens, directUnitOfWork, clock),
    view: new ViewTrackingLink(
      repository,
      tokens,
      positions,
      eta,
      trackingSettings,
      directUnitOfWork,
      clock,
    ),
    nearest: new NearestCouriers(positions, trackingSettings),
    last: new LastKnownPosition(positions),
    purge: new PurgeTrackingData(repository, trackingSettings, directUnitOfWork, clock),
  };
}

describe.each(TEST_MARKETS)('tracking use cases in market %s', (code) => {
  const market = testMarketContext(code, 'platform');
  const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'platform');
  const settings = trackingSettings.get(market.marketId);
  const vehicle = 'van';

  const ping = (s: ReturnType<typeof setup>, courierId: string, lat: number, extra = {}) =>
    s.record.perform(market, {
      courierId,
      lat,
      lng: 153.02,
      accuracyM: 10,
      recordedAt: s.clock.now().subtract({ seconds: 1 }),
      ...extra,
    });

  it('stores a ping as the live position and throttles the next one within the interval', async () => {
    const s = setup();
    expect(await ping(s, 'c-1', -27.47)).toEqual({
      ok: true,
      value: { latest: true, breadcrumbs: 0 },
    });
    expect(await s.last.perform(market, 'c-1')).toMatchObject({ point: { lat: -27.47 } });
    expect(await s.last.perform(other, 'c-1')).toBeUndefined();

    const throttled = await ping(s, 'c-1', -27.48);
    expect(throttled).toMatchObject({
      ok: false,
      error: { code: 'ping.throttled', retryAfterSeconds: settings.ping.minIntervalSeconds },
    });
    s.clock.advance(Temporal.Duration.from({ seconds: settings.ping.minIntervalSeconds }));
    expect((await ping(s, 'c-1', -27.48)).ok).toBe(true);
  });

  it('refuses an invalid ping without its coordinates in the refusal', async () => {
    const s = setup();
    const refused = await ping(s, 'c-1', 91);
    expect(refused).toMatchObject({ ok: false, error: { code: 'ping.invalid', field: 'lat' } });
    expect(JSON.stringify(refused)).not.toContain('91');
    const stale = await ping(s, 'c-1', -27.47, {
      recordedAt: s.clock.now().subtract({ seconds: settings.ping.maxAgeSeconds + 1 }),
    });
    expect(stale).toMatchObject({ ok: false, error: { code: 'ping.stale' } });
  });

  it('drops a courier from the live map after the Market TTL', async () => {
    const s = setup();
    await ping(s, 'c-1', -27.47);
    expect(await s.nearest.perform(market, pickup, 5000, 10)).toHaveLength(1);
    s.clock.advance(Temporal.Duration.from({ seconds: settings.livePositionTtlSeconds }));
    expect(await s.nearest.perform(market, pickup, 5000, 10)).toEqual([]);
    expect(await s.last.perform(market, 'c-1')).toBeUndefined();
  });

  it('finds the nearest couriers first, within the radius, capped by the Market limits', async () => {
    const s = setup();
    await ping(s, 'near', -27.471);
    await ping(s, 'far', -27.49);
    await ping(s, 'away', -28.5);
    const found = await s.nearest.perform(market, pickup, 5000, 10);
    expect(found.map((n) => n.position.courierId)).toEqual(['near', 'far']);
    expect(found[0]!.distanceMetres).toBeLessThan(found[1]!.distanceMetres);
    const capped = await s.nearest.perform(market, pickup, 10_000_000, 1);
    expect(capped).toHaveLength(1);
  });

  it('records the trail of a carried delivery, and gives its customer the courier and ETA', async () => {
    const s = setup();
    await s.track.perform(market, {
      deliveryId,
      status: 'ASSIGNED',
      courierId: 'c-1',
      vehicle,
      pickup,
      dropoff,
    });
    const link = await s.issue.perform(market, deliveryId);
    if (!link.ok) throw new Error(link.error.code);
    expect(link.value.expiresAt).toEqual(
      s.clock.now().add({ hours: settings.trackingLinkTtlHours }),
    );

    expect(await ping(s, 'c-1', -27.47)).toMatchObject({ ok: true, value: { breadcrumbs: 1 } });
    expect(await s.view.perform(market, link.value.token)).toEqual({
      ok: true,
      value: { phase: 'heading_to_pickup' },
    });

    await s.track.perform(market, {
      deliveryId,
      status: 'PICKED_UP',
      courierId: 'c-1',
      vehicle,
      pickup,
      dropoff,
    });
    const view = await s.view.perform(market, link.value.token);
    expect(view).toMatchObject({
      ok: true,
      value: { phase: 'on_the_way', courier: { lat: -27.47 } },
    });
    expect(view.ok && 'etaSeconds' in view.value && view.value.etaSeconds).toBeGreaterThan(0);

    // Another Market never resolves the link.
    expect(await s.view.perform(other, link.value.token)).toMatchObject({
      ok: false,
      error: { code: 'tracking.link-not-found' },
    });
  });

  it('hides the courier from a customer while another customer is being served', async () => {
    const s = setup();
    const secondId = '0195f000-0000-7000-8000-000000000002' as Id<'Delivery'>;
    await s.track.perform(market, {
      deliveryId,
      status: 'PICKED_UP',
      courierId: 'c-1',
      vehicle,
      pickup,
      dropoff,
    });
    await s.track.perform(market, {
      deliveryId: secondId,
      status: 'AT_DROPOFF',
      courierId: 'c-1',
      vehicle,
      pickup,
      dropoff,
    });
    const link = await s.issue.perform(market, deliveryId);
    if (!link.ok) throw new Error(link.error.code);
    await ping(s, 'c-1', -27.47);
    const view = await s.view.perform(market, link.value.token);
    expect(view).toMatchObject({ ok: true, value: { phase: 'on_the_way' } });
    expect(view.ok && 'courier' in view.value).toBe(false);

    await s.track.perform(market, {
      deliveryId: secondId,
      status: 'DELIVERED',
      courierId: 'c-1',
      vehicle,
      pickup,
      dropoff,
    });
    expect(await s.view.perform(market, link.value.token)).toMatchObject({
      ok: true,
      value: { courier: { lat: -27.47 } },
    });
  });

  it('closes the link and the trail once the delivery is delivered', async () => {
    const s = setup();
    await s.track.perform(market, {
      deliveryId,
      status: 'AT_DROPOFF',
      courierId: 'c-1',
      vehicle,
      pickup,
      dropoff,
    });
    const link = await s.issue.perform(market, deliveryId);
    if (!link.ok) throw new Error(link.error.code);
    await s.track.perform(market, {
      deliveryId,
      status: 'DELIVERED',
      courierId: 'c-1',
      vehicle,
      pickup,
      dropoff,
    });

    expect(await s.view.perform(market, link.value.token)).toMatchObject({
      ok: false,
      error: { code: 'tracking.ended' },
    });
    expect(await ping(s, 'c-1', -27.47)).toMatchObject({ ok: true, value: { breadcrumbs: 0 } });
    expect(await s.issue.perform(market, deliveryId)).toMatchObject({
      ok: false,
      error: { code: 'tracking.ended' },
    });
    expect(
      await s.track.perform(market, {
        deliveryId,
        status: 'PICKED_UP',
        courierId: 'c-1',
        pickup,
        dropoff,
      }),
    ).toMatchObject({ ok: false, error: { code: 'tracking.ended' } });
  });

  it('refuses a link for an untracked delivery, and an unknown or malformed token', async () => {
    const s = setup();
    expect(await s.issue.perform(market, deliveryId)).toMatchObject({
      ok: false,
      error: { code: 'tracking.delivery-not-found' },
    });
    for (const token of ['x'.repeat(43), 'short', '../../etc']) {
      expect(await s.view.perform(market, token)).toMatchObject({
        ok: false,
        error: { code: 'tracking.link-not-found' },
      });
    }
  });

  it('expires the link after the Market TTL', async () => {
    const s = setup();
    await s.track.perform(market, { deliveryId, status: 'DISPATCHING', pickup, dropoff });
    const link = await s.issue.perform(market, deliveryId);
    if (!link.ok) throw new Error(link.error.code);
    s.clock.advance(Temporal.Duration.from({ hours: settings.trackingLinkTtlHours }));
    expect(await s.view.perform(market, link.value.token)).toMatchObject({
      ok: false,
      error: { code: 'tracking.link-expired' },
    });
  });

  it('purges the trail after the Market retention and keeps newer points', async () => {
    const s = setup();
    await s.track.perform(market, {
      deliveryId,
      status: 'PICKED_UP',
      courierId: 'c-1',
      vehicle,
      pickup,
      dropoff,
    });
    await ping(s, 'c-1', -27.47);
    s.clock.advance(Temporal.Duration.from({ hours: settings.breadcrumbRetentionDays * 24 - 1 }));
    await ping(s, 'c-1', -27.48);
    expect(await s.purge.perform(market)).toEqual({ breadcrumbs: 0, deliveries: 0, links: 0 });
    s.clock.advance(Temporal.Duration.from({ hours: 1 }));
    expect(await s.purge.perform(market)).toMatchObject({ breadcrumbs: 1 });
    expect(await s.repository.trailOf(market, deliveryId, 10)).toHaveLength(1);
  });

  it('purges a delivery stuck in a status once it has not been reported for the retention', async () => {
    const s = setup();
    await s.track.perform(market, { deliveryId, status: 'DISPATCHING', pickup, dropoff });
    s.clock.advance(Temporal.Duration.from({ hours: settings.breadcrumbRetentionDays * 24 + 1 }));
    expect(await s.purge.perform(market)).toMatchObject({ deliveries: 1 });
    expect(await s.repository.findDelivery(market, deliveryId)).toBeUndefined();
  });
});
