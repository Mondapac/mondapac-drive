import { geoPoint, Temporal } from '@mondapac-drive/shared-kernel';
import { FixedClock, testMarketContext } from '@mondapac-drive/shared-kernel/testing';
import {
  GeocodingUnavailableError,
  InvalidAddressQueryError,
  type RoutingProvider,
} from '../../../platform/routing';
import { markets } from '../../../../test/support/delivery-markets';
import { TEST_MARKETS } from '../../../../test/support/test-config';
import type { GeocodeMiss, Geocoder, LocatedStop } from '../application/ports';
import { estimatedRoadMetres } from '../domain/geo-distance';
import {
  CachingGeocoder,
  normalisedAddress,
  RoutingDistanceProvider,
  RoutingGeocoder,
} from './routing-delivery.providers';

const A = geoPoint(-27.47, 153.02);
const B = geoPoint(-27.49, 153.03);
const AT_B: LocatedStop = { point: B, suburb: 'Newstead' };

function routing(overrides: Partial<RoutingProvider>): RoutingProvider {
  return {
    route: () => Promise.reject(new Error('unused')),
    matrix: () => Promise.reject(new Error('unused')),
    geocode: () => Promise.reject(new Error('unused')),
    ...overrides,
  };
}

const after = <T>(ms: number, value: T): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));

/** A geocoder that answers after a delay and counts its calls. */
class SlowGeocoder implements Geocoder {
  calls = 0;
  constructor(
    private readonly answer: LocatedStop | GeocodeMiss,
    private readonly delayMs = 0,
  ) {}
  locate(): Promise<LocatedStop | GeocodeMiss> {
    this.calls += 1;
    return after(this.delayMs, this.answer);
  }
}

describe.each(TEST_MARKETS)('delivery routing adapters (%s)', (code) => {
  const market = testMarketContext(code, 'default');
  const budget = markets.get(market.marketId).responseBudget;

  describe('RoutingDistanceProvider', () => {
    it('measures the road distance for the vehicle', async () => {
      const route = jest
        .fn()
        .mockResolvedValue({ distanceMetres: 4321, durationSeconds: 600, source: 'road' });
      await expect(
        new RoutingDistanceProvider(routing({ route }), markets).distance(
          market,
          A,
          B,
          'motorbike',
        ),
      ).resolves.toEqual({ metres: 4321, estimated: false });
      expect(route).toHaveBeenCalledWith(market, A, B, 'motorbike');
    });

    it("flags routing's own straight-line fallback as estimated", async () => {
      const route = jest
        .fn()
        .mockResolvedValue({ distanceMetres: 5000, durationSeconds: 600, source: 'straight_line' });
      await expect(
        new RoutingDistanceProvider(routing({ route }), markets).distance(market, A, B, 'car'),
      ).resolves.toEqual({ metres: 5000, estimated: true });
    });

    it('estimates from the straight line when routing is slower than the budget', async () => {
      const route = () =>
        after(budget.routeMs + 300, {
          distanceMetres: 1,
          durationSeconds: 1,
          source: 'road' as const,
        });
      const started = performance.now();
      const measured = await new RoutingDistanceProvider(routing({ route }), markets).distance(
        market,
        A,
        B,
        'car',
      );
      expect(performance.now() - started).toBeLessThan(budget.routeMs + 200);
      expect(measured).toEqual({
        metres: estimatedRoadMetres(A, B, budget.estimateRoadFactor),
        estimated: true,
      });
      // The Market's road factor stretches the straight line.
      expect(measured.metres).toBeGreaterThan(estimatedRoadMetres(A, B, 1));
    });
  });

  describe('RoutingGeocoder', () => {
    it('answers the geocoded point, or a miss', async () => {
      const found = new RoutingGeocoder(
        routing({
          geocode: () => Promise.resolve({ point: B, postcode: '1000', precision: 'postcode' }),
        }),
      );
      await expect(found.locate(market, '1 Road', '1000')).resolves.toEqual({ point: B });
      const suburb = new RoutingGeocoder(
        routing({
          geocode: () =>
            Promise.resolve({
              point: B,
              postcode: '1000',
              precision: 'address',
              locality: 'Newstead',
            }),
        }),
      );
      await expect(suburb.locate(market, '1 Road', '1000')).resolves.toEqual(AT_B);
      const none = new RoutingGeocoder(routing({ geocode: () => Promise.resolve(undefined) }));
      await expect(none.locate(market, '1 Road', '1000')).resolves.toBe('not-found');
      const down = new RoutingGeocoder(
        routing({
          geocode: () =>
            Promise.reject(new GeocodingUnavailableError('routing.geocoding-unconfigured')),
        }),
      );
      await expect(down.locate(market, '1 Road', '1000')).resolves.toBe('unavailable');
      const invalid = new RoutingGeocoder(
        routing({ geocode: () => Promise.reject(new InvalidAddressQueryError('postcode')) }),
      );
      await expect(invalid.locate(market, '1 Road', 'x')).resolves.toBe('not-found');
    });
  });

  describe('CachingGeocoder', () => {
    let clock: FixedClock;
    beforeEach(() => {
      clock = new FixedClock(Temporal.Instant.from('2026-10-25T00:00:00Z'));
    });

    it('keeps a found point for the Market TTL, by normalised address and postcode', async () => {
      const inner = new SlowGeocoder(AT_B);
      const geocoder = new CachingGeocoder(inner, markets, clock);
      await expect(geocoder.locate(market, '1 Example St, ', '1000')).resolves.toEqual(AT_B);
      await expect(geocoder.locate(market, '1  EXAMPLE st', ' 1000 ')).resolves.toEqual(AT_B);
      expect(inner.calls).toBe(budget.geocodeCacheSeconds === 0 ? 2 : 1);

      // Another postcode is another entry.
      await geocoder.locate(market, '1 Example St', '1001');
      const calls = inner.calls;
      clock.advance(Temporal.Duration.from({ seconds: budget.geocodeCacheSeconds }));
      await geocoder.locate(market, '1 Example St', '1000');
      expect(inner.calls).toBe(calls + 1);
    });

    it('keeps a full address per merchant, and a postcode alone for every merchant', async () => {
      const inner = new SlowGeocoder(AT_B);
      const geocoder = new CachingGeocoder(inner, markets, clock);
      await geocoder.locate(market, '1 Private Rd', '1000', { merchantId: 'm-1' });
      await geocoder.locate(market, '1 Private Rd', '1000', { merchantId: 'm-1' });
      expect(inner.calls).toBe(1);
      await geocoder.locate(market, '1 Private Rd', '1000', { merchantId: 'm-2' });
      expect(inner.calls).toBe(2);

      await geocoder.locate(market, '1000', '1000', { merchantId: 'm-1' });
      await geocoder.locate(market, '1000', '1000', { merchantId: 'm-2' });
      expect(inner.calls).toBe(3);
    });

    it.each(['not-found', 'unavailable'] as const)('does not keep a miss (%s)', async (miss) => {
      const inner = new SlowGeocoder(miss);
      const geocoder = new CachingGeocoder(inner, markets, clock);
      await expect(geocoder.locate(market, '9 Nowhere Rd', '1000')).resolves.toBe(miss);
      await expect(geocoder.locate(market, '9 Nowhere Rd', '1000')).resolves.toBe(miss);
      expect(inner.calls).toBe(2);
    });

    it('answers unavailable at the deadline, and the late point serves the retry', async () => {
      const inner = new SlowGeocoder(AT_B, budget.geocodeMs + 200);
      const geocoder = new CachingGeocoder(inner, markets, clock);
      const started = performance.now();
      await expect(geocoder.locate(market, '1 Slow St', '1000')).resolves.toBe('unavailable');
      expect(performance.now() - started).toBeLessThan(budget.geocodeMs + 150);

      // The retry joins the running lookup instead of starting a second one.
      await expect(geocoder.locate(market, '1 Slow St', '1000')).resolves.toEqual(AT_B);
      expect(inner.calls).toBe(1);
    });

    it('answers unavailable without a lookup when too many lookups are in flight', async () => {
      const inner = new SlowGeocoder(AT_B, 50);
      const geocoder = new CachingGeocoder(inner, markets, clock);
      const running = Array.from({ length: 1000 }, (_, i) =>
        geocoder.locate(market, `${i} Busy St`, '1000'),
      );
      await expect(geocoder.locate(market, '1 Late St', '1000')).resolves.toBe('unavailable');
      expect(inner.calls).toBe(1000);
      await Promise.all(running);
    });

    it('forgets expired points when it keeps a new one', async () => {
      if (budget.geocodeCacheSeconds === 0) return;
      const inner = new SlowGeocoder(AT_B);
      const geocoder = new CachingGeocoder(inner, markets, clock);
      await geocoder.locate(market, '1 Old St', '1000');
      clock.advance(Temporal.Duration.from({ seconds: budget.geocodeCacheSeconds }));
      await geocoder.locate(market, '2 New St', '1000');
      expect(geocoder.size).toBe(1);
    });

    it('drops the oldest entry when full', async () => {
      if (budget.geocodeCacheSeconds === 0) return;
      const inner = new SlowGeocoder(AT_B);
      const geocoder = new CachingGeocoder(inner, markets, clock, 2);
      for (const street of ['1 A St', '2 B St', '3 C St']) {
        await geocoder.locate(market, street, '1000');
      }
      await geocoder.locate(market, '3 C St', '1000');
      expect(inner.calls).toBe(3);
      await geocoder.locate(market, '1 A St', '1000');
      expect(inner.calls).toBe(4);
    });
  });
});

describe('normalisedAddress', () => {
  it('folds case, commas, full stops and space, and keeps / and -', () => {
    expect(normalisedAddress('  12/3 Queen St., Brisbane  ')).toBe('12/3 queen st brisbane');
    expect(normalisedAddress('1-23 Smith St')).not.toBe(normalisedAddress('1/23 Smith St'));
    expect(normalisedAddress('Ｑｕｅｅｎ St')).toBe('queen st');
  });
});
