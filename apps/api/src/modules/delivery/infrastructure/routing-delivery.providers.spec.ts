import { geoPoint } from '@mondapac-drive/shared-kernel';
import { testMarketContext } from '@mondapac-drive/shared-kernel/testing';
import {
  GeocodingUnavailableError,
  InvalidAddressQueryError,
  type RoutingProvider,
} from '../../../platform/routing';
import { TEST_MARKETS } from '../../../../test/support/test-config';
import { RoutingDistanceProvider, RoutingGeocoder } from './routing-delivery.providers';

const A = geoPoint(-27.47, 153.02);
const B = geoPoint(-27.49, 153.03);

function routing(overrides: Partial<RoutingProvider>): RoutingProvider {
  return {
    route: () => Promise.reject(new Error('unused')),
    matrix: () => Promise.reject(new Error('unused')),
    geocode: () => Promise.reject(new Error('unused')),
    ...overrides,
  };
}

describe.each(TEST_MARKETS)('delivery routing adapters (%s)', (code) => {
  const market = testMarketContext(code, 'default');

  it('measures the road distance for the vehicle', async () => {
    const route = jest.fn().mockResolvedValue({
      distanceMetres: 4321,
      durationSeconds: 600,
      source: 'road',
    });
    await expect(
      new RoutingDistanceProvider(routing({ route })).roadDistanceMetres(market, A, B, 'motorbike'),
    ).resolves.toBe(4321);
    expect(route).toHaveBeenCalledWith(market, A, B, 'motorbike');
  });

  it('answers the geocoded point, or a miss', async () => {
    const found = new RoutingGeocoder(
      routing({
        geocode: () => Promise.resolve({ point: B, postcode: '1000', precision: 'postcode' }),
      }),
    );
    await expect(found.locate(market, '1 Road', '1000')).resolves.toEqual(B);
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
