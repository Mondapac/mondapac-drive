import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { MarketId } from '@mondapac-drive/shared-kernel';
import request from 'supertest';
import { SystemClock } from '../../src/platform/clock/system-clock';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { ROUTING_PROVIDER } from '../../src/platform/routing';
import { GoogleRoutesClient } from '../../src/platform/routing/google-routes-client';
import {
  ResilientRoutingProvider,
  type MarketRouting,
} from '../../src/platform/routing/resilient-routing-provider';
import { InMemoryRouteCache } from '../../src/platform/routing/route-cache';
import {
  FakeGoogleMapsServer,
  GEOCODE_PATH,
  ROUTES_PATH,
  type FakeAnswer,
} from '../support/fake-google-maps-server';
import { createTestApp } from '../support/test-app';
import {
  panelHeaders,
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
} from '../support/test-config';
import { TestActors, type MerchantActor } from './actor-support';
import { testDatabaseUrl } from './test-database';

// How fast the marketplace's two calls answer (handoff 34): the marketplace gives a quote or a
// booking 2.5 s per attempt, so Drive budgets 2 s at p95. The map provider is a local fake with
// realistic latency; the database, the gate and the HTTP stack are the real ones. When the
// provider is slow, a quote falls back to an estimated distance and a geocoding lookup answers
// 503 with Retry-After at the Market's budget, and the retry is served from the cache.

const POSTCODE: Readonly<Record<string, string>> = { AU: '4000', ZZ: '1000' };
const P95_BUDGET_MS = 2000;
const SAMPLES = 20;
const markets = loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS);

/** The 95th percentile of the samples (nearest rank). */
function p95(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1]!;
}

describe('delivery response time for the marketplace (database integration)', () => {
  const server = new FakeGoogleMapsServer();
  const clock = new SystemClock();
  let provider: ResilientRoutingProvider;
  /** Extra delay the fake adds to every answer of a path, on top of its normal latency. */
  const stall = { geocode: 0, route: 0 };
  let tick = 0;
  /** Normal provider latency, 120 to 420 ms, varying from call to call. */
  const latency = () => 120 + ((tick += 7) % 31) * 10;

  beforeAll(async () => {
    await server.start();
    server.on(GEOCODE_PATH, (): FakeAnswer => ({
      delayMs: latency() + stall.geocode,
      body: {
        status: 'OK',
        results: [{ geometry: { location: { lat: -27.47 - (tick % 50) / 1000, lng: 153.02 } } }],
      },
    }));
    server.on(ROUTES_PATH, (): FakeAnswer => ({
      delayMs: latency() + stall.route,
      body: { routes: [{ distanceMeters: 4200, duration: '700s' }] },
    }));
    const routing = new Map<MarketId, MarketRouting>();
    for (const marketId of TEST_MARKET_IDS) {
      const market = markets.get(marketId)!;
      const config = market.routing!;
      const road = new GoogleRoutesClient({
        apiKey: 'test-key',
        google: config.google!,
        languageCode: market.defaultLocale,
        timeoutMs: config.timeoutMs,
        routesBaseUrl: server.baseUrl,
        geocodingBaseUrl: server.baseUrl,
      });
      routing.set(marketId, { config, road, cacheSecret: 'test-key' });
    }
    provider = new ResilientRoutingProvider(routing, new InMemoryRouteCache(clock), clock);
  });

  afterAll(() => server.stop());

  afterEach(() => {
    stall.geocode = 0;
    stall.route = 0;
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const budget = markets.get(TEST_MARKET_IDS[TEST_MARKETS.indexOf(code)]!)!.delivery
      .responseBudget;
    let app: NestExpressApplication;
    let merchant: MerchantActor;

    // One application per Market: the rate limiter counts per client address across Markets,
    // and these suites send more requests than ZZ's limit allows one origin in a minute.
    beforeAll(async () => {
      ({ app } = await createTestApp({
        panelOrigins: true,
        env: { DATABASE_URL: testDatabaseUrl(), HOSTED_MARKETS: TEST_MARKETS.join(',') },
        override: (builder) => builder.overrideProvider(ROUTING_PROVIDER).useValue(provider),
      }));
      const actors = new TestActors(app, code);
      await actors.seedRoles();
      const admin = await actors.admin(panelHeaders(code).origin);
      merchant = await actors.merchant(admin, `Merchant ${randomUUID()}`);
    });

    afterAll(() => app.close());

    const parcel = { weightGrams: 2000, volumeLitres: 10, temperature: 'ambient' };
    const stop = (address: string) => ({
      address,
      postcode: POSTCODE[code]!,
      contactName: 'Sam',
      contactPhone: '+61 400 000 000',
    });
    /** The marketplace's checkout quote: postcodes only, the postcode standing in as the address. */
    const quoteBody = (dropoffAddress = POSTCODE[code]!) => ({
      pickup: { postcode: POSTCODE[code], address: POSTCODE[code] },
      dropoff: { postcode: POSTCODE[code], address: dropoffAddress },
      parcel,
      mode: 'on_demand',
    });
    const bookingBody = (address: string) => ({
      externalReference: `order-${randomUUID()}`,
      pickup: stop(`1 Shop St ${code}`),
      dropoff: stop(address),
      parcel,
      mode: 'on_demand',
    });
    const timed = async (path: string, body: object) => {
      const started = performance.now();
      const response = await request(app.getHttpServer())
        .post(path)
        .set({ 'x-market-id': code, ...merchant.headers })
        .send(body);
      return { response, ms: performance.now() - started };
    };

    it(`quotes within ${P95_BUDGET_MS} ms at p95, geocoding new addresses, ten at a time`, async () => {
      const samples: number[] = [];
      for (let batch = 0; batch < SAMPLES / 10; batch += 1) {
        const answers = await Promise.all(
          Array.from({ length: 10 }, (_, i) =>
            timed('/delivery/quotes', quoteBody(`${batch * 10 + i} Quote St`)),
          ),
        );
        for (const { response, ms } of answers) {
          expect(response.status).toBe(200);
          expect(response.body).toMatchObject({ distanceEstimated: false });
          samples.push(ms);
        }
      }
      expect(p95(samples)).toBeLessThan(P95_BUDGET_MS);
    });

    it(`books within ${P95_BUDGET_MS} ms at p95, geocoding both stops`, async () => {
      const samples: number[] = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        const { response, ms } = await timed(
          '/delivery/deliveries',
          bookingBody(`${i} Booking Rd`),
        );
        expect(response.status).toBe(201);
        samples.push(ms);
      }
      expect(p95(samples)).toBeLessThan(P95_BUDGET_MS);
    });

    it('answers a repeated address from the cache, without asking the provider', async () => {
      await timed('/delivery/quotes', quoteBody('7 Repeat Ave'));
      const before = server.calls(GEOCODE_PATH).length;
      const { response } = await timed('/delivery/quotes', quoteBody('7  REPEAT ave,'));
      expect(response.status).toBe(200);
      expect(server.calls(GEOCODE_PATH).length).toBe(before);
    });

    it('quotes from an estimated distance, in time, while routing stalls', async () => {
      stall.route = 5000;
      const { response, ms } = await timed('/delivery/quotes', quoteBody('1 Stalled Route Rd'));
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ distanceEstimated: true });
      expect(ms).toBeLessThan(P95_BUDGET_MS);
    });

    it('answers 503 with Retry-After while geocoding stalls, and serves the retry', async () => {
      stall.geocode = budget.geocodeMs;
      const body = bookingBody(`${randomUUID()} Slow Geocode St`);
      const first = await timed('/delivery/deliveries', body);
      expect(first.response.status).toBe(503);
      expect(first.response.body).toMatchObject({ code: 'address.geocoding-unavailable' });
      expect(first.response.headers['retry-after']).toBe('2');
      expect(first.ms).toBeLessThan(P95_BUDGET_MS);

      // The marketplace waits Retry-After; by then the late answer is in the cache.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const geocodes = server.calls(GEOCODE_PATH).length;
      const retried = await timed('/delivery/deliveries', body);
      expect(retried.response.status).toBe(201);
      expect(server.calls(GEOCODE_PATH).length).toBe(geocodes);
    });
  });
});
