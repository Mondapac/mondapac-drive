import { geoPoint, Temporal, type MarketId } from '@mondapac-drive/shared-kernel';
import { FixedClock, testMarketContext } from '@mondapac-drive/shared-kernel/testing';
import {
  FakeGoogleMapsServer,
  GEOCODE_PATH,
  MATRIX_PATH,
  ROUTES_PATH,
} from '../../../test/support/fake-google-maps-server';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../test/support/test-config';
import { loadMarketConfigs } from '../market-config/market-config';
import { GoogleRoutesClient } from './google-routes-client';
import { ResilientRoutingProvider, type MarketRouting } from './resilient-routing-provider';
import { InMemoryRouteCache, type RouteCache } from './route-cache';
import { DEFAULT_ROUTING_CONFIG } from './routing-config';
import {
  GeocodingUnavailableError,
  InvalidAddressQueryError,
  InvalidMatrixRequestError,
} from './routing-provider';
import { StraightLineRouter } from './straight-line-router';

const markets = loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS);
const A = geoPoint(-27.4698, 153.0251);
const B = geoPoint(-27.481, 153.02);
const C = geoPoint(-27.5, 153.05);
const ROAD = { routes: [{ distanceMeters: 2345, duration: '412s' }] };

describe.each(TEST_MARKET_IDS)('ResilientRoutingProvider (%s)', (marketId) => {
  const market = testMarketContext(marketId, 'default');
  const config = markets.get(marketId)!.routing!;
  const straightLine = new StraightLineRouter(config.straightLine);
  const server = new FakeGoogleMapsServer();
  let clock: FixedClock;
  let cache: InMemoryRouteCache;

  beforeAll(() => server.start());
  afterAll(() => server.stop());
  beforeEach(() => {
    server.requests.length = 0;
    clock = new FixedClock(Temporal.Instant.from('2026-10-24T00:00:00Z'));
    cache = new InMemoryRouteCache(clock);
  });

  function provider(routeCache: RouteCache = cache): ResilientRoutingProvider {
    const road = new GoogleRoutesClient({
      apiKey: 'test-key',
      google: config.google!,
      languageCode: 'en-ZZ',
      timeoutMs: 200,
      routesBaseUrl: server.baseUrl,
      geocodingBaseUrl: server.baseUrl,
    });
    const routing = new Map<MarketId, MarketRouting>([[market.marketId, { config, road }]]);
    return new ResilientRoutingProvider(routing, routeCache, clock);
  }

  it('answers the road route and caches it for the configured TTL', async () => {
    server.on(ROUTES_PATH, () => ({ body: ROAD }));
    const routing = provider();
    const road = { distanceMetres: 2345, durationSeconds: 412, source: 'road' };
    await expect(routing.route(market, A, B, 'car')).resolves.toEqual(road);
    await expect(routing.route(market, A, B, 'car')).resolves.toEqual(road);
    expect(server.calls(ROUTES_PATH)).toHaveLength(1);

    // Another vehicle is another key.
    await routing.route(market, A, B, 'van');
    expect(server.calls(ROUTES_PATH)).toHaveLength(2);

    clock.advance(Temporal.Duration.from({ seconds: config.cacheTtlSeconds }));
    await routing.route(market, A, B, 'car');
    expect(server.calls(ROUTES_PATH)).toHaveLength(3);
  });

  it('falls back to the straight line on a failure, and says so', async () => {
    server.on(ROUTES_PATH, () => ({ status: 503 }));
    await expect(provider().route(market, A, B, 'car')).resolves.toEqual(
      straightLine.route(A, B, 'car'),
    );
  });

  it('falls back on a timeout', async () => {
    server.on(ROUTES_PATH, () => ({ delayMs: 400, body: ROAD }));
    const estimate = await provider().route(market, A, B, 'motorbike');
    expect(estimate.source).toBe('straight_line');
  });

  it('opens the breaker after the threshold and stops calling until the open period ends', async () => {
    server.on(ROUTES_PATH, () => ({ status: 500 }));
    const routing = provider();
    const { failureThreshold, openSeconds } = config.circuitBreaker;
    for (let i = 0; i < failureThreshold + 3; i += 1) await routing.route(market, A, B, 'car');
    expect(server.calls(ROUTES_PATH)).toHaveLength(failureThreshold);

    server.on(ROUTES_PATH, () => ({ body: ROAD }));
    clock.advance(Temporal.Duration.from({ seconds: openSeconds }));
    await expect(routing.route(market, A, B, 'car')).resolves.toMatchObject({ source: 'road' });
    await expect(routing.route(market, A, C, 'car')).resolves.toMatchObject({ source: 'road' });
  });

  it('a "no route" answer falls back without opening the breaker', async () => {
    server.on(ROUTES_PATH, () => ({ body: {} }));
    const routing = provider();
    for (let i = 0; i < config.circuitBreaker.failureThreshold + 1; i += 1) {
      await expect(routing.route(market, A, B, 'car')).resolves.toMatchObject({
        source: 'straight_line',
      });
    }
    expect(server.calls(ROUTES_PATH)).toHaveLength(config.circuitBreaker.failureThreshold + 1);
  });

  it('a broken cache never fails a route', async () => {
    server.on(ROUTES_PATH, () => ({ body: ROAD }));
    const broken: RouteCache = {
      get: () => Promise.reject(new Error('down')),
      set: () => Promise.reject(new Error('down')),
      close: () => Promise.resolve(),
    };
    await expect(provider(broken).route(market, A, B, 'car')).resolves.toMatchObject({
      source: 'road',
    });
  });

  it('fills the matrix from the cache and the provider, and the gaps by straight line', async () => {
    server.on(ROUTES_PATH, () => ({ body: ROAD }));
    const routing = provider();
    await routing.route(market, A, B, 'car');
    server.on(MATRIX_PATH, () => ({
      body: [
        {
          originIndex: 1,
          destinationIndex: 0,
          distanceMeters: 900,
          duration: '100s',
          condition: 'ROUTE_EXISTS',
        },
      ],
    }));
    const result = await routing.matrix(market, [A, C], [B], 'car');
    expect(result).toEqual([
      [{ distanceMetres: 2345, durationSeconds: 412, source: 'road' }],
      [{ distanceMetres: 900, durationSeconds: 100, source: 'road' }],
    ]);

    // Every cell is cached now: no further matrix call.
    await routing.matrix(market, [A, C], [B], 'car');
    expect(server.calls(MATRIX_PATH)).toHaveLength(1);

    server.on(MATRIX_PATH, () => ({ status: 500 }));
    const fallback = await routing.matrix(market, [B], [A, C], 'car');
    expect(fallback).toEqual([[straightLine.route(B, A, 'car'), straightLine.route(B, C, 'car')]]);
  });

  it('refuses a matrix over the provider limit', async () => {
    const many = Array.from({ length: 26 }, () => A);
    await expect(provider().matrix(market, many, many, 'car')).rejects.toBeInstanceOf(
      InvalidMatrixRequestError,
    );
  });

  it("falls back to the postcode's centre when the address is not found", async () => {
    server.on(GEOCODE_PATH, ({ query }) =>
      query.has('address')
        ? { body: { status: 'ZERO_RESULTS', results: [] } }
        : {
            body: {
              status: 'OK',
              results: [{ geometry: { location: { lat: C.lat, lng: C.lng } } }],
            },
          },
    );
    await expect(
      provider().geocode(market, { address: '99 Unknown Road', postcode: '1500' }),
    ).resolves.toEqual({ point: C, postcode: undefined, precision: 'postcode' });
    await expect(
      provider().geocode(market, { address: '99 Unknown Road' }),
    ).resolves.toBeUndefined();
  });

  it('refuses an empty address or a postcode that could change the provider filter', async () => {
    await expect(provider().geocode(market, { address: '  ' })).rejects.toBeInstanceOf(
      InvalidAddressQueryError,
    );
    await expect(
      provider().geocode(market, { address: '1 Road', postcode: '1000|country:US' }),
    ).rejects.toMatchObject({ field: 'postcode' });
    expect(server.calls(GEOCODE_PATH)).toHaveLength(0);
  });

  it('reports geocoding unavailable when the provider fails', async () => {
    server.on(GEOCODE_PATH, () => ({ status: 500 }));
    await expect(provider().geocode(market, { address: '1 Road' })).rejects.toMatchObject({
      code: 'routing.provider-failed',
    });
  });
});

describe('ResilientRoutingProvider without a road provider', () => {
  const market = testMarketContext('ZZ', 'default');
  const clock = new FixedClock(Temporal.Instant.from('2026-10-24T00:00:00Z'));
  const routing = new ResilientRoutingProvider(
    new Map([[market.marketId, { config: DEFAULT_ROUTING_CONFIG, road: undefined }]]),
    new InMemoryRouteCache(clock),
    clock,
  );

  it('answers straight-line routes and matrices', async () => {
    await expect(routing.route(market, A, B, 'bicycle')).resolves.toMatchObject({
      source: 'straight_line',
    });
    const result = await routing.matrix(market, [A, B], [C], 'van');
    expect(result.flat().map((cell) => cell.source)).toEqual(['straight_line', 'straight_line']);
  });

  it('has no geocoding', async () => {
    await expect(routing.geocode(market, { address: '1 Road' })).rejects.toEqual(
      new GeocodingUnavailableError('routing.geocoding-unconfigured'),
    );
  });
});
