import { createHmac, randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { Clock, GeoPoint, MarketContext } from '@mondapac-drive/shared-kernel';
import {
  GeocodingUnavailableError,
  InvalidAddressQueryError,
  type RoutingProvider,
} from '../../../platform/routing';
import type {
  DistanceProvider,
  GeocodeMiss,
  Geocoder,
  MarketSettingsProvider,
  MeasuredDistance,
} from '../application/ports';
import { estimatedRoadMetres } from '../domain/geo-distance';
import type { VehicleType } from '../domain/vehicle';

const TIMED_OUT = Symbol('timed-out');

/** The work's answer, or {@link TIMED_OUT} after `ms`. The work itself goes on. */
function within<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
    timer.unref();
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Delivery's distance port over the platform router, within the Market's
 * `responseBudget.routeMs`. A road route that does not answer in time, or routing's own
 * straight-line fallback, gives an estimated distance (the quote says so). A late road answer
 * still lands in routing's route cache, so the next quote for the same stops is a road one.
 */
export class RoutingDistanceProvider implements DistanceProvider {
  private readonly logger = new Logger('DeliveryDistance');

  constructor(
    private readonly routing: RoutingProvider,
    private readonly markets: MarketSettingsProvider,
  ) {}

  async distance(
    market: MarketContext,
    from: GeoPoint,
    to: GeoPoint,
    vehicle: VehicleType,
  ): Promise<MeasuredDistance> {
    const { routeMs, estimateRoadFactor } = this.markets.get(market.marketId).responseBudget;
    const route = await within(this.routing.route(market, from, to, vehicle), routeMs);
    if (route === TIMED_OUT) {
      this.logger.warn({
        msg: 'distance estimated',
        marketId: market.marketId,
        code: 'route.slow',
      });
      return { metres: estimatedRoadMetres(from, to, estimateRoadFactor), estimated: true };
    }
    return { metres: route.distanceMetres, estimated: route.source !== 'road' };
  }
}

/** Delivery's geocoding port over the platform router (address, else the postcode's centre). */
export class RoutingGeocoder implements Geocoder {
  constructor(private readonly routing: RoutingProvider) {}

  async locate(
    market: MarketContext,
    address: string,
    postcode: string,
  ): Promise<GeoPoint | GeocodeMiss> {
    try {
      const found = await this.routing.geocode(market, { address, postcode });
      return found === undefined ? 'not-found' : found.point;
    } catch (error) {
      if (error instanceof GeocodingUnavailableError) return 'unavailable';
      if (error instanceof InvalidAddressQueryError) return 'not-found';
      throw error;
    }
  }
}

/**
 * The address as a cache sees it: Unicode-normalised, lower case, punctuation and runs of space
 * folded to one space, so "1 Example St," and "1  example st" are one entry.
 */
export function normalisedAddress(address: string): string {
  return address
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * A {@link Geocoder} that keeps found points for the Market's `responseBudget.geocodeCacheSeconds`
 * and answers within its `geocodeMs`. The marketplace quotes and books the same addresses again
 * and again (a quote sends the postcode as the address), so most lookups never leave the process.
 *
 * - **Keys** are an HMAC of the Market, the normalised address and the postcode under a key made
 *   for this process: no address is a key, and a key cannot be turned back into one (Privacy Act).
 * - **Misses** are not kept: a not-found or unavailable answer is asked again next time.
 * - **Slow lookups** answer `unavailable` at the deadline but keep running; their point fills the
 *   cache, and a request for the same address meanwhile joins the running lookup, so the
 *   marketplace's retry is quick.
 */
export class CachingGeocoder implements Geocoder {
  private readonly logger = new Logger('DeliveryGeocoding');
  readonly #secret = randomBytes(32);
  readonly #entries = new Map<string, { point: GeoPoint; expiresAtMs: number }>();
  readonly #pending = new Map<string, Promise<GeoPoint | GeocodeMiss>>();

  constructor(
    private readonly inner: Geocoder,
    private readonly markets: MarketSettingsProvider,
    private readonly clock: Clock,
    private readonly maxEntries = 10_000,
  ) {}

  async locate(
    market: MarketContext,
    address: string,
    postcode: string,
  ): Promise<GeoPoint | GeocodeMiss> {
    const { geocodeMs, geocodeCacheSeconds } = this.markets.get(market.marketId).responseBudget;
    const key = this.#keyOf(market, address, postcode);
    const cached = this.#cached(key);
    if (cached !== undefined) return cached;

    let lookup = this.#pending.get(key);
    if (lookup === undefined) {
      lookup = this.inner
        .locate(market, address, postcode)
        .then((found) => {
          if (typeof found !== 'string') this.#keep(key, found, geocodeCacheSeconds);
          return found;
        })
        .finally(() => this.#pending.delete(key));
      this.#pending.set(key, lookup);
    }
    const answered = await within(lookup, geocodeMs);
    if (answered !== TIMED_OUT) return answered;
    this.logger.warn({ msg: 'geocoding slow', marketId: market.marketId, code: 'geocode.slow' });
    return 'unavailable';
  }

  #keyOf(market: MarketContext, address: string, postcode: string): string {
    return createHmac('sha256', this.#secret)
      .update(
        [market.marketId, normalisedAddress(address), postcode.trim().toUpperCase()].join('|'),
      )
      .digest('base64url');
  }

  #cached(key: string): GeoPoint | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAtMs <= this.clock.now().epochMilliseconds) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.point;
  }

  #keep(key: string, point: GeoPoint, ttlSeconds: number): void {
    if (ttlSeconds === 0) return;
    this.#entries.delete(key);
    if (this.#entries.size >= this.maxEntries) {
      // Map keeps insertion order: drop the oldest entry.
      const oldest = this.#entries.keys().next();
      if (oldest.done !== true) this.#entries.delete(oldest.value);
    }
    this.#entries.set(key, {
      point,
      expiresAtMs: this.clock.now().epochMilliseconds + ttlSeconds * 1000,
    });
  }
}
