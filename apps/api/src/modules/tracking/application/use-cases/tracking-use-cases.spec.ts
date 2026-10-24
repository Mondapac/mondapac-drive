import { parseId, Temporal, type CallContext, type Id } from '@mondapac-drive/shared-kernel';
import type { MarketContext } from '@mondapac-drive/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac-drive/shared-kernel/testing';
import { expectSystemOnly, openGate } from '../../../../../test/support/system-only-denial';
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
import { CourierPositions } from './courier-positions.use-case';
import { DeliveryTrail } from './delivery-trail.use-case';
import { IssueTrackingLink } from './issue-tracking-link.use-case';
import { PurgeTrackingData } from './purge-tracking-data.use-case';
import { RecordLocationPing, type LocationPingInput } from './record-location-ping.use-case';
import { TrackDelivery } from './track-delivery.use-case';
import { ViewCourierPosition, ViewNearbyCouriers } from './view-courier-positions.use-case';
import { ViewTrackingLink } from './view-tracking-link.use-case';

const deliveryId = '0195f000-0000-7000-8000-000000000001' as Id<'Delivery'>;
const pickup = { lat: -27.47, lng: 153.02 };
const dropoff = { lat: -27.5, lng: 153.05 };

function setup() {
  const clock = newClock();
  const gate = openGate();
  const positions = new InMemoryLivePositionStore(clock);
  const repository = new InMemoryTrackingRepository();
  const tokens = new CryptoTrackingTokens();
  const eta = new RoutingEtaProvider(fakeRouting(), trackingSettings, clock);
  const settings = trackingSettings;
  const unitOfWork = directUnitOfWork;
  return {
    clock,
    positions,
    repository,
    record: new RecordLocationPing(gate, {
      positions,
      tracking: repository,
      settings,
      unitOfWork,
      clock,
    }),
    track: new TrackDelivery(gate, { tracking: repository, unitOfWork, clock }),
    issue: new IssueTrackingLink(gate, {
      tracking: repository,
      settings,
      tokens,
      unitOfWork,
      clock,
    }),
    view: new ViewTrackingLink(gate, {
      tracking: repository,
      tokens,
      positions,
      eta,
      settings,
      unitOfWork,
      clock,
    }),
    nearby: new ViewNearbyCouriers(gate, { positions, settings }),
    position: new ViewCourierPosition(gate, { positions, settings }),
    trail: new DeliveryTrail(gate, { tracking: repository, unitOfWork }),
    directory: new CourierPositions({ positions, settings }),
    purge: new PurgeTrackingData(gate, { tracking: repository, settings, unitOfWork, clock }),
  };
}

const id = (n: number) => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value;
};

function signedIn(market: MarketContext, population: 'courier' | 'admin', n: number) {
  return testCallContext(
    market,
    testAuthenticatedActor(market, {
      population,
      accountId: id(n) as never,
      sessionId: id(n + 0x100) as never,
      merchantId: null,
    }),
    `tracking-${population}-${n.toString(16).padStart(4, '0')}`,
  );
}

const courierIdOf = (context: CallContext) =>
  context.actor.kind === 'authenticated' ? context.actor.accountId : 'none';

describe.each(TEST_MARKETS)('tracking use cases in market %s', (code) => {
  const market = testMarketContext(code, 'platform');
  const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'platform');
  const otherTenant = testMarketContext(code, 'second-tenant');
  const settings = trackingSettings.get(market.marketId);
  const vehicle = 'van';
  const system = testCallContext(market, 'system', 'tracking-system-0001');
  const anonymous = testCallContext(market, 'anonymous', 'tracking-anonymous-0001');
  const admin = signedIn(market, 'admin', 0xa1);
  const courier = signedIn(market, 'courier', 0xc1);
  const courierId = courierIdOf(courier);

  const fix = (s: ReturnType<typeof setup>, lat: number, extra = {}): LocationPingInput => ({
    lat,
    lng: 153.02,
    accuracyM: 10,
    recordedAt: s.clock.now().subtract({ seconds: 1 }),
    ...extra,
  });
  const ping = (s: ReturnType<typeof setup>, by: CallContext, lat: number, extra = {}) =>
    s.record.execute(by, { pings: [fix(s, lat, extra)] });
  const near = (s: ReturnType<typeof setup>, radiusMetres = 5000, limit = 10) =>
    s.nearby.execute(admin, { point: pickup, radiusMetres, limit });
  const track = (s: ReturnType<typeof setup>, status: string, extra = {}) =>
    s.track.execute(system, {
      deliveryId,
      status: status as never,
      courierId,
      vehicle,
      pickup,
      dropoff,
      ...extra,
    });

  it("stores a ping as the signed-in courier's live position and throttles the next batch", async () => {
    const s = setup();
    expect(await ping(s, courier, -27.47)).toEqual({
      ok: true,
      value: { accepted: 1, rejected: [], latest: true, breadcrumbs: 0 },
    });
    expect(await s.position.execute(admin, { courierId })).toMatchObject({
      ok: true,
      value: { courierId, point: { lat: -27.47 } },
    });
    expect(
      await s.directory.lastKnown(
        testCallContext(other, 'system', 'tracking-other-0002'),
        courierId,
      ),
    ).toBe(undefined);

    const throttled = await ping(s, courier, -27.48);
    expect(throttled).toMatchObject({
      ok: false,
      error: { code: 'ping.throttled', retryAfterSeconds: settings.ping.minIntervalSeconds },
    });
    s.clock.advance(Temporal.Duration.from({ seconds: settings.ping.minIntervalSeconds }));
    expect((await ping(s, courier, -27.48)).ok).toBe(true);
  });

  it('keeps the latest fix of a batch as the position and lists the invalid ones by index', async () => {
    const s = setup();
    const now = s.clock.now();
    const result = await s.record.execute(courier, {
      pings: [
        fix(s, -27.47, { recordedAt: now.subtract({ seconds: 20 }) }),
        fix(s, 91),
        fix(s, -27.49, { recordedAt: now.subtract({ seconds: 2 }) }),
        fix(s, -27.48, { recordedAt: now.subtract({ seconds: 10 }) }),
      ],
    });
    expect(result).toEqual({
      ok: true,
      value: {
        accepted: 3,
        rejected: [{ index: 1, code: 'ping.invalid', field: 'lat' }],
        latest: true,
        breadcrumbs: 0,
      },
    });
    expect(JSON.stringify(result)).not.toContain('91');
    expect(await s.position.execute(admin, { courierId })).toMatchObject({
      ok: true,
      value: { point: { lat: -27.49 } },
    });
  });

  it('refuses a batch with no valid ping, without its coordinates in the refusal', async () => {
    const s = setup();
    const refused = await ping(s, courier, 91);
    expect(refused).toMatchObject({ ok: false, error: { code: 'ping.invalid', field: 'lat' } });
    expect(JSON.stringify(refused)).not.toContain('91');
    const stale = await ping(s, courier, -27.47, {
      recordedAt: s.clock.now().subtract({ seconds: settings.ping.maxAgeSeconds + 1 }),
    });
    expect(stale).toMatchObject({ ok: false, error: { code: 'ping.stale' } });
    expect(await s.record.execute(courier, { pings: [] })).toMatchObject({
      ok: false,
      error: { code: 'ping.invalid', field: 'pings' },
    });
  });

  it('records pings only for a courier: an admin, the system and the anonymous are refused', async () => {
    const s = setup();
    for (const caller of [admin, system, anonymous]) {
      expect(await ping(s, caller, -27.47)).toMatchObject({ ok: false });
    }
    expect(await near(s)).toEqual({ ok: true, value: [] });
  });

  it('serves the live map to admins only', async () => {
    const s = setup();
    await ping(s, courier, -27.47);
    for (const caller of [courier, system, anonymous]) {
      expect(
        await s.nearby.execute(caller, { point: pickup, radiusMetres: 5000, limit: 10 }),
      ).toEqual(expect.objectContaining({ ok: false }));
      expect(await s.position.execute(caller, { courierId })).toEqual(
        expect.objectContaining({ ok: false }),
      );
      expect(await s.trail.execute(caller, { deliveryId })).toEqual(
        expect.objectContaining({ ok: false }),
      );
    }
  });

  it('keeps each tenant of a Market apart', async () => {
    const s = setup();
    await ping(s, courier, -27.47);
    const elsewhere = signedIn(otherTenant, 'admin', 0xa2);
    expect(
      await s.nearby.execute(elsewhere, { point: pickup, radiusMetres: 5000, limit: 10 }),
    ).toEqual({ ok: true, value: [] });
    expect(await s.position.execute(elsewhere, { courierId })).toMatchObject({
      ok: false,
      error: { code: 'tracking.position-not-found' },
    });
  });

  it('drops a courier from the live map after the Market TTL', async () => {
    const s = setup();
    await ping(s, courier, -27.47);
    expect(await near(s)).toMatchObject({ ok: true, value: [expect.anything()] });
    s.clock.advance(Temporal.Duration.from({ seconds: settings.livePositionTtlSeconds }));
    expect(await near(s)).toEqual({ ok: true, value: [] });
    expect(await s.position.execute(admin, { courierId })).toMatchObject({
      ok: false,
      error: { code: 'tracking.position-not-found' },
    });
  });

  it('finds the nearest couriers first, within the radius, capped by the Market limits', async () => {
    const s = setup();
    const [a, b, c] = [0xd1, 0xd2, 0xd3].map((n) => signedIn(market, 'courier', n));
    await ping(s, a!, -27.471);
    await ping(s, b!, -27.49);
    await ping(s, c!, -28.5);
    const found = await near(s);
    if (!found.ok) throw new Error(found.error.code);
    expect(found.value.map((n) => n.position.courierId)).toEqual([
      courierIdOf(a!),
      courierIdOf(b!),
    ]);
    expect(found.value[0]!.distanceMetres).toBeLessThan(found.value[1]!.distanceMetres);
    expect(await near(s, 10_000_000, 1)).toMatchObject({ ok: true, value: [expect.anything()] });

    // Dispatch reads the same positions under its own caller's context.
    const forDispatch = await s.directory.nearest(courier, {
      point: pickup,
      radiusMetres: 5000,
      limit: 10,
    });
    expect(forDispatch).toHaveLength(2);
  });

  it('records the trail of a carried delivery, and gives its customer the courier and ETA', async () => {
    const s = setup();
    await track(s, 'ASSIGNED');
    const link = await s.issue.execute(system, { deliveryId });
    if (!link.ok) throw new Error(link.error.code);
    expect(link.value.expiresAt).toEqual(
      s.clock.now().add({ hours: settings.trackingLinkTtlHours }),
    );

    expect(await ping(s, courier, -27.47)).toMatchObject({ ok: true, value: { breadcrumbs: 1 } });
    expect(await s.trail.execute(admin, { deliveryId })).toMatchObject({
      ok: true,
      value: [{ courierId, point: { lat: -27.47 } }],
    });
    const token = link.value.token;
    expect(await s.view.execute(anonymous, { token })).toEqual({
      ok: true,
      value: { phase: 'heading_to_pickup' },
    });

    await track(s, 'PICKED_UP');
    const view = await s.view.execute(anonymous, { token });
    expect(view).toMatchObject({
      ok: true,
      value: { phase: 'on_the_way', courier: { lat: -27.47 } },
    });
    expect(view.ok && 'etaSeconds' in view.value && view.value.etaSeconds).toBeGreaterThan(0);

    // Another Market never resolves the link.
    expect(
      await s.view.execute(testCallContext(other, 'anonymous', 'tracking-other-0001'), { token }),
    ).toMatchObject({ ok: false, error: { code: 'tracking.link-not-found' } });
  });

  it('hides the courier from a customer while another customer is being served', async () => {
    const s = setup();
    const secondId = '0195f000-0000-7000-8000-000000000002' as Id<'Delivery'>;
    await track(s, 'PICKED_UP');
    await track(s, 'AT_DROPOFF', { deliveryId: secondId });
    const link = await s.issue.execute(system, { deliveryId });
    if (!link.ok) throw new Error(link.error.code);
    const token = link.value.token;
    await ping(s, courier, -27.47);
    const view = await s.view.execute(anonymous, { token });
    expect(view).toMatchObject({ ok: true, value: { phase: 'on_the_way' } });
    expect(view.ok && 'courier' in view.value).toBe(false);

    await track(s, 'DELIVERED', { deliveryId: secondId });
    expect(await s.view.execute(anonymous, { token })).toMatchObject({
      ok: true,
      value: { courier: { lat: -27.47 } },
    });
  });

  it('closes the link and the trail once the delivery is delivered', async () => {
    const s = setup();
    await track(s, 'AT_DROPOFF');
    const link = await s.issue.execute(system, { deliveryId });
    if (!link.ok) throw new Error(link.error.code);
    await track(s, 'DELIVERED');

    expect(await s.view.execute(anonymous, { token: link.value.token })).toMatchObject({
      ok: false,
      error: { code: 'tracking.ended' },
    });
    expect(await ping(s, courier, -27.47)).toMatchObject({ ok: true, value: { breadcrumbs: 0 } });
    expect(await s.issue.execute(system, { deliveryId })).toMatchObject({
      ok: false,
      error: { code: 'tracking.ended' },
    });
    expect(await track(s, 'PICKED_UP', { vehicle: undefined })).toMatchObject({
      ok: false,
      error: { code: 'tracking.ended' },
    });
  });

  it('refuses a link for an untracked delivery, and an unknown or malformed token', async () => {
    const s = setup();
    expect(await s.issue.execute(system, { deliveryId })).toMatchObject({
      ok: false,
      error: { code: 'tracking.delivery-not-found' },
    });
    for (const token of ['x'.repeat(43), 'short', '../../etc']) {
      expect(await s.view.execute(anonymous, { token })).toMatchObject({
        ok: false,
        error: { code: 'tracking.link-not-found' },
      });
    }
  });

  it('expires the link after the Market TTL', async () => {
    const s = setup();
    await s.track.execute(system, { deliveryId, status: 'DISPATCHING', pickup, dropoff });
    const link = await s.issue.execute(system, { deliveryId });
    if (!link.ok) throw new Error(link.error.code);
    s.clock.advance(Temporal.Duration.from({ hours: settings.trackingLinkTtlHours }));
    expect(await s.view.execute(anonymous, { token: link.value.token })).toMatchObject({
      ok: false,
      error: { code: 'tracking.link-expired' },
    });
  });

  it('purges the trail after the Market retention and keeps newer points', async () => {
    const s = setup();
    await track(s, 'PICKED_UP');
    await ping(s, courier, -27.47);
    s.clock.advance(Temporal.Duration.from({ hours: settings.breadcrumbRetentionDays * 24 - 1 }));
    await ping(s, courier, -27.48);
    expect(await s.purge.execute(system, {})).toEqual({
      ok: true,
      value: { breadcrumbs: 0, deliveries: 0, links: 0 },
    });
    s.clock.advance(Temporal.Duration.from({ hours: 1 }));
    expect(await s.purge.execute(system, {})).toMatchObject({
      ok: true,
      value: { breadcrumbs: 1 },
    });
    expect(await s.repository.trailOf(market, deliveryId, 10)).toHaveLength(1);
  });

  it('purges a delivery stuck in a status once it has not been reported for the retention', async () => {
    const s = setup();
    await s.track.execute(system, { deliveryId, status: 'DISPATCHING', pickup, dropoff });
    s.clock.advance(Temporal.Duration.from({ hours: settings.breadcrumbRetentionDays * 24 + 1 }));
    expect(await s.purge.execute(system, {})).toMatchObject({ ok: true, value: { deliveries: 1 } });
    expect(await s.repository.findDelivery(market, deliveryId)).toBeUndefined();
  });

  it('runs tracking, link issue and purge for the system actor only', async () => {
    const s = setup();
    await expectSystemOnly(code, (context) =>
      s.track.execute(context, { deliveryId, status: 'DISPATCHING', pickup, dropoff }),
    );
    await expectSystemOnly(code, (context) => s.issue.execute(context, { deliveryId }));
    await expectSystemOnly(code, (context) => s.purge.execute(context, {}));
    expect(await s.repository.findDelivery(market, deliveryId)).toBeUndefined();
  });
});
