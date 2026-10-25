import { geoPoint } from '@mondapac-drive/shared-kernel';
import {
  FakeGoogleMapsServer,
  GEOCODE_PATH,
  MATRIX_PATH,
  ROUTES_PATH,
} from '../../../test/support/fake-google-maps-server';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../test/support/test-config';
import { loadMarketConfigs } from '../market-config/market-config';
import { GoogleRoutesClient, GoogleRoutingError, NoRouteError } from './google-routes-client';

const markets = loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS);
const A = geoPoint(-27.4698, 153.0251);
const B = geoPoint(-27.481, 153.02);

describe.each(TEST_MARKET_IDS)('GoogleRoutesClient (%s)', (marketId) => {
  const market = markets.get(marketId)!;
  const google = market.routing!.google!;
  const server = new FakeGoogleMapsServer();
  let client: GoogleRoutesClient;

  beforeAll(() => server.start());
  afterAll(() => server.stop());
  beforeEach(() => {
    server.requests.length = 0;
    client = new GoogleRoutesClient({
      apiKey: 'test-key',
      google,
      languageCode: market.defaultLocale,
      timeoutMs: 200,
      routesBaseUrl: server.baseUrl,
      geocodingBaseUrl: server.baseUrl,
    });
  });

  it("asks computeRoutes with the key, a field mask, the Market's region and travel mode", async () => {
    server.on(ROUTES_PATH, () => ({
      body: { routes: [{ distanceMeters: 2345, duration: '412s' }] },
    }));
    await expect(client.route(A, B, 'car')).resolves.toEqual({
      distanceMetres: 2345,
      durationSeconds: 412,
    });
    const [request] = server.calls(ROUTES_PATH);
    expect(request!.headers['x-goog-api-key']).toBe('test-key');
    expect(request!.headers['x-goog-fieldmask']).toBe('routes.distanceMeters,routes.duration');
    expect(request!.body).toMatchObject({
      origin: { location: { latLng: { latitude: A.lat, longitude: A.lng } } },
      travelMode: google.travelModes.car,
      routingPreference: google.trafficAware ? 'TRAFFIC_AWARE' : 'TRAFFIC_UNAWARE',
      regionCode: google.regionCode,
    });
  });

  it('maps the bicycle to its travel mode, without a routing preference', async () => {
    server.on(ROUTES_PATH, () => ({ body: { routes: [{ distanceMeters: 10, duration: '3s' }] } }));
    await client.route(A, B, 'bicycle');
    const body = server.calls(ROUTES_PATH)[0]!.body as Record<string, unknown>;
    expect(body.travelMode).toBe('BICYCLE');
    expect(body).not.toHaveProperty('routingPreference');
  });

  it('reads a left-out distance as 0 and rounds fractional seconds', async () => {
    server.on(ROUTES_PATH, () => ({ body: { routes: [{ duration: '0.6s' }] } }));
    await expect(client.route(A, A, 'van')).resolves.toEqual({
      distanceMetres: 0,
      durationSeconds: 1,
    });
  });

  it('answers NoRouteError when the provider finds no route', async () => {
    server.on(ROUTES_PATH, () => ({ body: {} }));
    await expect(client.route(A, B, 'car')).rejects.toBeInstanceOf(NoRouteError);
  });

  it.each([
    [{ status: 500, body: { error: 'x' } }, 'routing.provider-refused'],
    [{ status: 429, body: {} }, 'routing.provider-refused'],
    [{ status: 403, body: {} }, 'routing.provider-rejected'],
    [{ body: { routes: [{ distanceMeters: 1, duration: 'soon' }] } }, 'routing.provider-malformed'],
    [{ delayMs: 400, body: {} }, 'routing.provider-timeout'],
  ])('fails with a code only (%j)', async (answer, code) => {
    server.on(ROUTES_PATH, () => answer);
    const error = await client.route(A, B, 'car').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GoogleRoutingError);
    expect((error as GoogleRoutingError).code).toBe(code);
    expect((error as Error).message).not.toContain('test-key');
    expect((error as Error).message).not.toContain(String(A.lat));
  });

  it('fails as unreachable when nothing listens', async () => {
    const offline = new GoogleRoutesClient({
      apiKey: 'k',
      google,
      languageCode: market.defaultLocale,
      timeoutMs: 200,
      routesBaseUrl: 'http://127.0.0.1:1',
    });
    await expect(offline.route(A, B, 'car')).rejects.toMatchObject({
      code: 'routing.provider-unreachable',
    });
  });

  it('places matrix elements by index; a missing index is 0 and a failed element is empty', async () => {
    server.on(MATRIX_PATH, () => ({
      body: [
        { destinationIndex: 1, distanceMeters: 300, duration: '60s', condition: 'ROUTE_EXISTS' },
        { distanceMeters: 100, duration: '20s', condition: 'ROUTE_EXISTS' },
        { originIndex: 1, condition: 'ROUTE_NOT_FOUND' },
        { originIndex: 1, destinationIndex: 1, status: { code: 3 } },
      ],
    }));
    await expect(client.matrix([A, B], [A, B], 'motorbike')).resolves.toEqual([
      [
        { distanceMetres: 100, durationSeconds: 20 },
        { distanceMetres: 300, durationSeconds: 60 },
      ],
      [undefined, undefined],
    ]);
    const body = server.calls(MATRIX_PATH)[0]!.body as { origins: unknown[]; travelMode: string };
    expect(body.origins).toHaveLength(2);
    expect(body.travelMode).toBe(google.travelModes.motorbike);
  });

  it('does not follow a redirect, which would carry the key elsewhere', async () => {
    server.on(ROUTES_PATH, () => ({
      status: 307,
      body: {},
      headers: { location: 'http://127.0.0.1:1/x' },
    }));
    await expect(client.route(A, B, 'car')).rejects.toMatchObject({
      code: 'routing.provider-unreachable',
    });
  });

  it('refuses a matrix element outside the request', async () => {
    server.on(MATRIX_PATH, () => ({
      body: [{ originIndex: 5, distanceMeters: 1, duration: '1s', condition: 'ROUTE_EXISTS' }],
    }));
    await expect(client.matrix([A], [B], 'car')).rejects.toMatchObject({
      code: 'routing.provider-malformed',
    });
  });

  it("geocodes within the Market's country and postcode, in its language", async () => {
    server.on(GEOCODE_PATH, () => ({
      body: {
        status: 'OK',
        results: [
          {
            geometry: { location: { lat: B.lat, lng: B.lng } },
            address_components: [{ long_name: '1234', types: ['postal_code'] }],
          },
        ],
      },
    }));
    await expect(client.geocode('1 Example Street', '1234')).resolves.toEqual({
      point: B,
      postcode: '1234',
      precision: 'address',
    });
    const { query } = server.calls(GEOCODE_PATH)[0]!;
    expect(query.get('address')).toBe('1 Example Street');
    expect(query.get('region')).toBe(google.regionCode);
    expect(query.get('components')).toBe(
      `country:${google.regionCode.toUpperCase()}|postal_code:1234`,
    );
    expect(query.get('language')).toBe(market.defaultLocale);
    expect(query.get('key')).toBe('test-key');
  });

  it("keeps the address's locality as plain text, never a postcode centre's", async () => {
    const answer = (locality: string) => ({
      body: {
        status: 'OK',
        results: [
          {
            geometry: { location: { lat: B.lat, lng: B.lng } },
            address_components: [
              { long_name: locality, types: ['locality', 'political'] },
              { long_name: '1234', types: ['postal_code'] },
            ],
          },
        ],
      },
    });
    server.on(GEOCODE_PATH, () => answer(' Fortitude Valley '));
    await expect(client.geocode('1 Example Street', '1234')).resolves.toEqual({
      point: B,
      postcode: '1234',
      precision: 'address',
      locality: 'Fortitude Valley',
    });
    server.on(GEOCODE_PATH, () => answer('Fortitude\u0007 Valley'));
    await expect(client.geocode('1 Example Street', '1234')).resolves.not.toHaveProperty(
      'locality',
    );
    server.on(GEOCODE_PATH, () => answer('x'.repeat(81)));
    await expect(client.geocode('1 Example Street', '1234')).resolves.not.toHaveProperty(
      'locality',
    );
    server.on(GEOCODE_PATH, () => answer('Fortitude Valley'));
    await expect(client.geocodePostcode('1234')).resolves.not.toHaveProperty('locality');
  });

  it('geocodes a postcode alone as its centre', async () => {
    server.on(GEOCODE_PATH, () => ({
      body: { status: 'OK', results: [{ geometry: { location: { lat: A.lat, lng: A.lng } } }] },
    }));
    await expect(client.geocodePostcode('1000')).resolves.toEqual({
      point: A,
      postcode: undefined,
      precision: 'postcode',
    });
    expect(server.calls(GEOCODE_PATH)[0]!.query.has('address')).toBe(false);
  });

  it('answers undefined for ZERO_RESULTS and fails on an error status', async () => {
    server.on(GEOCODE_PATH, () => ({ body: { status: 'ZERO_RESULTS', results: [] } }));
    await expect(client.geocode('nowhere')).resolves.toBeUndefined();
    server.on(GEOCODE_PATH, () => ({ body: { status: 'REQUEST_DENIED' } }));
    await expect(client.geocode('anywhere')).rejects.toMatchObject({
      code: 'routing.provider-rejected',
    });
    server.on(GEOCODE_PATH, () => ({ body: { status: 'OVER_QUERY_LIMIT' } }));
    await expect(client.geocode('anywhere')).rejects.toMatchObject({
      code: 'routing.provider-refused',
    });
  });
});
