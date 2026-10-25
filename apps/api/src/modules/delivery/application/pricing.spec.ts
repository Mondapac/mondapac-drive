import {
  geoPoint,
  Temporal,
  type GeoPoint,
  type MarketContext,
} from '@mondapac-drive/shared-kernel';
import { FixedClock, testMarketContext } from '@mondapac-drive/shared-kernel/testing';
import { markets } from '../../../../test/support/delivery-markets';
import { TEST_MARKETS } from '../../../../test/support/test-config';
import type { VehicleType } from '../domain/vehicle';
import type { DistanceProvider, GeocodeMiss, Geocoder } from './ports';
import { DeliveryPricing, type QuoteDeliveryInput } from './pricing';

const POSTCODE: Readonly<Record<string, string>> = { AU: '4000', ZZ: '1000' };
const GIVEN = geoPoint(-27.47, 153.02);
const GEOCODED = geoPoint(-27.49, 153.03);

class RecordingDistances implements DistanceProvider {
  readonly calls: { from: GeoPoint; to: GeoPoint; vehicle: VehicleType }[] = [];
  constructor(private readonly estimated = false) {}
  distance(_m: MarketContext, from: GeoPoint, to: GeoPoint, vehicle: VehicleType) {
    this.calls.push({ from, to, vehicle });
    return Promise.resolve({ metres: 3000, estimated: this.estimated });
  }
}

class FakeGeocoder implements Geocoder {
  readonly calls: { address: string; postcode: string }[] = [];
  constructor(private readonly answer: GeoPoint | GeocodeMiss) {}
  locate(_m: MarketContext, address: string, postcode: string) {
    this.calls.push({ address, postcode });
    return Promise.resolve(this.answer);
  }
}

describe.each(TEST_MARKETS)('DeliveryPricing stop location (%s)', (code) => {
  const market = testMarketContext(code, 'default');
  const clock = new FixedClock(Temporal.Instant.from('2026-10-24T00:00:00Z'));
  const postcode = POSTCODE[code]!;
  const input = (pickup: QuoteDeliveryInput['pickup']): QuoteDeliveryInput => ({
    pickup,
    dropoff: { postcode, point: GIVEN },
    parcel: { weightGrams: 1000, volumeLitres: 5, temperature: 'ambient' },
    mode: 'on_demand',
  });
  const pricing = (geocoder: Geocoder, distances = new RecordingDistances()) =>
    new DeliveryPricing({ markets, distances, geocoder, clock });

  it('uses a given point without geocoding, for the requested vehicle', async () => {
    const geocoder = new FakeGeocoder(GEOCODED);
    const distances = new RecordingDistances();
    const result = await pricing(geocoder, distances).price(market, {
      ...input({ postcode, point: GIVEN, address: '1 Example Street' }),
      vehicle: 'van',
    });
    expect(result.ok).toBe(true);
    expect(geocoder.calls).toEqual([]);
    expect(distances.calls).toEqual([{ from: GIVEN, to: GIVEN, vehicle: 'van' }]);
  });

  it('geocodes a stop without a point from its address and postcode', async () => {
    const geocoder = new FakeGeocoder(GEOCODED);
    const distances = new RecordingDistances();
    const result = await pricing(geocoder, distances).price(
      market,
      input({ postcode, address: '1 Example Street' }),
    );
    expect(result.ok && result.value.pickupPoint).toEqual(GEOCODED);
    expect(geocoder.calls).toEqual([{ address: '1 Example Street', postcode }]);
    expect(distances.calls[0]!.from).toEqual(GEOCODED);
  });

  it.each([
    ['not-found', 'address.not-found'],
    ['unavailable', 'address.geocoding-unavailable'],
  ] as const)('refuses the quote when geocoding answers %s', async (miss, code) => {
    const result = await pricing(new FakeGeocoder(miss)).price(
      market,
      input({ postcode, address: '1 Example Street' }),
    );
    expect(!result.ok && result.error.code).toBe(code);
  });

  it('refuses a stop with neither point nor address', async () => {
    const result = await pricing(new FakeGeocoder(GEOCODED)).price(market, input({ postcode }));
    expect(!result.ok && result.error.code).toBe('address.point-required');
  });

  it.each([false, true])(
    'carries whether the distance is estimated (%s) into the quote',
    async (estimated) => {
      const result = await pricing(
        new FakeGeocoder(GEOCODED),
        new RecordingDistances(estimated),
      ).price(market, input({ postcode, point: GIVEN }));
      expect(result.ok && result.value.quote).toMatchObject({
        distanceMetres: 3000,
        distanceEstimated: estimated,
      });
    },
  );
});
