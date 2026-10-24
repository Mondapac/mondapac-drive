import { Temporal } from '@mondapac-drive/shared-kernel';
import { testMarketContext } from '@mondapac-drive/shared-kernel/testing';
import { fakeRouting, newClock, trackingSettings } from '../../../../test/support/tracking-markets';
import { TEST_MARKETS } from '../../../../test/support/test-config';
import { RoutingEtaProvider } from './routing-eta.provider';

const to = { lat: -27.5, lng: 153.05 };

describe.each(TEST_MARKETS)('road ETA in market %s', (code) => {
  const market = testMarketContext(code, 'platform');
  const refresh = trackingSettings.get(market.marketId).etaRefreshSeconds;

  it('asks routing once per route cell and refresh period, and counts the time since down', async () => {
    const clock = newClock();
    const routing = fakeRouting();
    const eta = new RoutingEtaProvider(routing, trackingSettings, clock);
    const first = await eta.etaSeconds(market, { lat: -27.47, lng: 153.02 }, to, 'car');
    expect(first! % 60).toBe(0);
    expect(first).toBeGreaterThanOrEqual(60);

    // A few metres further, half a refresh later: the same answer, less the time since.
    clock.advance(Temporal.Duration.from({ seconds: Math.floor(refresh / 2) }));
    const again = await eta.etaSeconds(market, { lat: -27.4701, lng: 153.0201 }, to, 'car');
    expect(routing.calls).toBe(1);
    expect(again).toBeLessThanOrEqual(first!);

    clock.advance(Temporal.Duration.from({ seconds: refresh }));
    await eta.etaSeconds(market, { lat: -27.47, lng: 153.02 }, to, 'car');
    expect(routing.calls).toBe(2);

    // Another vehicle or a cell further away is a new route.
    await eta.etaSeconds(market, { lat: -27.47, lng: 153.02 }, to, 'van');
    await eta.etaSeconds(market, { lat: -27.48, lng: 153.02 }, to, 'van');
    expect(routing.calls).toBe(4);
  });

  it('shows at least a minute when the courier is already there', async () => {
    const eta = new RoutingEtaProvider(fakeRouting(), trackingSettings, newClock());
    expect(await eta.etaSeconds(market, to, to, 'car')).toBe(60);
  });
});
