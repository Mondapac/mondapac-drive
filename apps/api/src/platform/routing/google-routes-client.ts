import type { GeoPoint } from '@mondapac-drive/shared-kernel';
import { geoPoint } from '@mondapac-drive/shared-kernel';
import type { RoutingConfig, RoutingVehicleType } from './routing-config';
import type { GeocodedAddress } from './routing-provider';

/** The public Google endpoints; tests point the client at a fake server instead. */
export const GOOGLE_ROUTES_BASE_URL = 'https://routes.googleapis.com';
export const GOOGLE_GEOCODING_BASE_URL = 'https://maps.googleapis.com';

/** `fetch`, narrowed to what the client uses, so tests can pass a fake. */
export type HttpFetch = (
  url: string,
  init: {
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
) => Promise<{ readonly ok: boolean; readonly status: number; json(): Promise<unknown> }>;

export type GoogleRoutingErrorCode =
  | 'routing.provider-timeout'
  | 'routing.provider-unreachable'
  | 'routing.provider-refused'
  | 'routing.provider-malformed';

/**
 * A failed call: carries a code and the HTTP status only, never the request (coordinates,
 * address, key) or the provider's answer.
 */
export class GoogleRoutingError extends Error {
  constructor(
    readonly code: GoogleRoutingErrorCode,
    readonly status?: number,
  ) {
    super(status === undefined ? code : `${code} (HTTP ${status})`);
    this.name = 'GoogleRoutingError';
  }
}

/** The provider answered, and there is no road route between the points. Not an outage. */
export class NoRouteError extends Error {
  constructor() {
    super('routing.no-route');
    this.name = 'NoRouteError';
  }
}

export interface RoadLeg {
  readonly distanceMetres: number;
  readonly durationSeconds: number;
}

export interface GoogleRoutesClientOptions {
  readonly apiKey: string;
  readonly google: NonNullable<RoutingConfig['google']>;
  /** BCP 47 language for geocoding answers: the Market's default locale. */
  readonly languageCode: string;
  readonly timeoutMs: number;
  readonly routesBaseUrl?: string;
  readonly geocodingBaseUrl?: string;
  readonly fetchFn?: HttpFetch;
}

const TRAFFIC_MODES: ReadonlySet<string> = new Set(['DRIVE', 'TWO_WHEELER']);

/**
 * The Google Maps Platform adapter: Routes API `computeRoutes` and `computeRouteMatrix`, and the
 * Geocoding API. One client per Market, bound to that Market's key, region and travel modes.
 */
export class GoogleRoutesClient {
  readonly #routesBase: string;
  readonly #geocodingBase: string;
  readonly #fetch: HttpFetch;

  constructor(private readonly options: GoogleRoutesClientOptions) {
    this.#routesBase = options.routesBaseUrl ?? GOOGLE_ROUTES_BASE_URL;
    this.#geocodingBase = options.geocodingBaseUrl ?? GOOGLE_GEOCODING_BASE_URL;
    this.#fetch = options.fetchFn ?? ((url, init) => fetch(url, init));
  }

  /** @throws GoogleRoutingError on an outage, NoRouteError when no road connects the points. */
  async route(
    origin: GeoPoint,
    destination: GeoPoint,
    vehicle: RoutingVehicleType,
  ): Promise<RoadLeg> {
    const body = await this.#post(
      '/directions/v2:computeRoutes',
      'routes.distanceMeters,routes.duration',
      {
        origin: waypoint(origin),
        destination: waypoint(destination),
        ...this.#modeFields(vehicle),
        regionCode: this.options.google.regionCode,
        units: 'METRIC',
      },
    );
    if (typeof body !== 'object' || body === null) throw malformed();
    const routes = (body as { routes?: unknown }).routes;
    if (routes === undefined) throw new NoRouteError();
    if (!Array.isArray(routes)) throw malformed();
    const first: unknown = routes[0];
    if (first === undefined) throw new NoRouteError();
    return parseLeg(first);
  }

  /**
   * `result[i][j]` is the leg from origin i to destination j, or undefined where the provider
   * found no route or failed that one element.
   * @throws GoogleRoutingError when the whole call fails.
   */
  async matrix(
    origins: readonly GeoPoint[],
    destinations: readonly GeoPoint[],
    vehicle: RoutingVehicleType,
  ): Promise<(RoadLeg | undefined)[][]> {
    const body = await this.#post(
      '/distanceMatrix/v2:computeRouteMatrix',
      'originIndex,destinationIndex,distanceMeters,duration,condition,status',
      {
        origins: origins.map((point) => ({ waypoint: waypoint(point) })),
        destinations: destinations.map((point) => ({ waypoint: waypoint(point) })),
        ...this.#modeFields(vehicle),
        regionCode: this.options.google.regionCode,
      },
    );
    if (!Array.isArray(body)) throw malformed();
    const cells: (RoadLeg | undefined)[][] = origins.map(() => destinations.map(() => undefined));
    for (const element of body as unknown[]) {
      if (typeof element !== 'object' || element === null) throw malformed();
      const fields = element as Record<string, unknown>;
      // proto3 JSON leaves out zero values: a missing index is 0.
      const i = fields.originIndex ?? 0;
      const j = fields.destinationIndex ?? 0;
      if (typeof i !== 'number' || typeof j !== 'number') throw malformed();
      const row = cells[i];
      if (row === undefined || j < 0 || j >= row.length) throw malformed();
      const status = fields.status as { code?: unknown } | undefined;
      if (status?.code !== undefined && status.code !== 0) continue;
      if (fields.condition !== 'ROUTE_EXISTS') continue;
      row[j] = parseLeg(fields);
    }
    return cells;
  }

  /**
   * The address, restricted to the Market's country (and to the postcode when given).
   * @throws GoogleRoutingError on an outage or an error status.
   */
  geocode(address: string, postcode?: string): Promise<GeocodedAddress | undefined> {
    return this.#geocode({ address }, postcode, 'address');
  }

  /**
   * The centre of a postcode in the Market's country (a components-only query).
   * @throws GoogleRoutingError on an outage or an error status.
   */
  geocodePostcode(postcode: string): Promise<GeocodedAddress | undefined> {
    return this.#geocode({}, postcode, 'postcode');
  }

  async #geocode(
    params: Record<string, string>,
    postcode: string | undefined,
    precision: GeocodedAddress['precision'],
  ): Promise<GeocodedAddress | undefined> {
    const region = this.options.google.regionCode;
    const components = [`country:${region.toUpperCase()}`];
    if (postcode !== undefined) components.push(`postal_code:${postcode}`);
    const query = new URLSearchParams({
      ...params,
      region,
      components: components.join('|'),
      language: this.options.languageCode,
      key: this.options.apiKey,
    });
    const body = await this.#call(
      `${this.#geocodingBase}/maps/api/geocode/json?${query.toString()}`,
      {
        method: 'GET',
        headers: { accept: 'application/json' },
      },
    );
    if (typeof body !== 'object' || body === null) throw malformed();
    const { status, results } = body as { status?: unknown; results?: unknown };
    if (status === 'ZERO_RESULTS') return undefined;
    if (status !== 'OK') throw new GoogleRoutingError('routing.provider-refused');
    if (!Array.isArray(results)) throw malformed();
    const first = results[0] as
      | {
          geometry?: { location?: { lat?: unknown; lng?: unknown } };
          address_components?: { long_name?: unknown; types?: unknown }[];
        }
      | undefined;
    if (first === undefined) return undefined;
    const { lat, lng } = first.geometry?.location ?? {};
    if (typeof lat !== 'number' || typeof lng !== 'number') throw malformed();
    let point: GeoPoint;
    try {
      point = geoPoint(lat, lng);
    } catch {
      throw malformed();
    }
    const found = (first.address_components ?? []).find(
      (component) => Array.isArray(component.types) && component.types.includes('postal_code'),
    )?.long_name;
    return { point, postcode: typeof found === 'string' ? found : undefined, precision };
  }

  #modeFields(vehicle: RoutingVehicleType): Record<string, string> {
    const travelMode = this.options.google.travelModes[vehicle];
    if (!TRAFFIC_MODES.has(travelMode)) return { travelMode };
    return {
      travelMode,
      routingPreference: this.options.google.trafficAware ? 'TRAFFIC_AWARE' : 'TRAFFIC_UNAWARE',
    };
  }

  #post(path: string, fieldMask: string, payload: unknown): Promise<unknown> {
    return this.#call(`${this.#routesBase}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': this.options.apiKey,
        'x-goog-fieldmask': fieldMask,
      },
      body: JSON.stringify(payload),
    });
  }

  async #call(
    url: string,
    init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string },
  ): Promise<unknown> {
    let response: Awaited<ReturnType<HttpFetch>>;
    try {
      response = await this.#fetch(url, {
        ...init,
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      throw new GoogleRoutingError(
        isTimeout(error) ? 'routing.provider-timeout' : 'routing.provider-unreachable',
      );
    }
    if (!response.ok) throw new GoogleRoutingError('routing.provider-refused', response.status);
    try {
      return await response.json();
    } catch (error) {
      if (isTimeout(error)) throw new GoogleRoutingError('routing.provider-timeout');
      throw malformed();
    }
  }
}

function waypoint(point: GeoPoint) {
  return { location: { latLng: { latitude: point.lat, longitude: point.lng } } };
}

/** Google writes a duration as seconds with an "s" suffix, e.g. "754s" or "12.5s". */
const DURATION = /^(\d+(?:\.\d+)?)s$/;

function parseLeg(value: unknown): RoadLeg {
  if (typeof value !== 'object' || value === null) throw malformed();
  const { distanceMeters, duration } = value as { distanceMeters?: unknown; duration?: unknown };
  // proto3 JSON leaves out a zero distance.
  const distance = distanceMeters ?? 0;
  if (typeof distance !== 'number' || !Number.isFinite(distance) || distance < 0) throw malformed();
  const match = typeof duration === 'string' ? DURATION.exec(duration) : null;
  if (match === null) throw malformed();
  return { distanceMetres: Math.round(distance), durationSeconds: Math.round(Number(match[1])) };
}

function malformed(): GoogleRoutingError {
  return new GoogleRoutingError('routing.provider-malformed');
}

function isTimeout(error: unknown): boolean {
  // fetch rejects with a DOMException, which is not an Error of every realm (Jest's VM).
  const name =
    typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
  return name === 'TimeoutError' || name === 'AbortError';
}
