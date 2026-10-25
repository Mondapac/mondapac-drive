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
  GeocodeAsker,
  GeocodeMiss,
  Geocoder,
  LocatedStop,
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
  ): Promise<LocatedStop | GeocodeMiss> {
    try {
      const found = await this.routing.geocode(market, { address, postcode });
      if (found === undefined) return 'not-found';
      return found.locality === undefined
        ? { point: found.point }
        : { point: found.point, suburb: found.locality };
    } catch (error) {
      if (error instanceof GeocodingUnavailableError) return 'unavailable';
      if (error instanceof InvalidAddressQueryError) return 'not-found';
      throw error;
    }
  }
}

/**
 * The address as a cache sees it: Unicode-normalised, lower case, commas, full stops and runs of
 * space folded to one space, so "1 Example St," and "1  example st" are one entry. Every other
 * character is kept: "1/23" and "1-23" are different addresses.
 */
export function normalisedAddress(address: string): string {
  return address
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s,.]+/gu, ' ')
    .trim();
}

/** Lookups in flight at once; past it a new address answers `unavailable` without a lookup. */
const MAX_PENDING_LOOKUPS = 1000;

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
  readonly #entries = new Map<string, { located: LocatedStop; expiresAtMs: number }>();
  readonly #pending = new Map<string, Promise<LocatedStop | GeocodeMiss>>();

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
    asker?: GeocodeAsker,
  ): Promise<LocatedStop | GeocodeMiss> {
    const { geocodeMs, geocodeCacheSeconds } = this.markets.get(market.marketId).responseBudget;
    const key = this.#keyOf(market, address, postcode, asker?.merchantId ?? null);
    const cached = this.#cached(key);
    if (cached !== undefined) return cached;

    let lookup = this.#pending.get(key);
    if (lookup === undefined) {
      if (this.#pending.size >= MAX_PENDING_LOOKUPS) {
        this.logger.warn({
          msg: 'geocoding saturated',
          marketId: market.marketId,
          code: 'geocode.saturated',
        });
        return 'unavailable';
      }
      lookup = this.inner
        .locate(market, address, postcode, asker)
        .then((found) => {
          if (typeof found !== 'string') this.#keep(key, found, geocodeCacheSeconds);
          return found;
        })
        .finally(() => this.#pending.delete(key));
      this.#pending.set(key, lookup);
      // A failure after the deadline reaches no caller: log its kind (never the address).
      lookup.catch((error: unknown) =>
        this.logger.warn({
          msg: 'geocoding failed',
          marketId: market.marketId,
          code: 'geocode.failed',
          error: error instanceof Error ? error.name : 'unknown',
        }),
      );
    }
    const answered = await within(lookup, geocodeMs);
    if (answered !== TIMED_OUT) return answered;
    this.logger.warn({ msg: 'geocoding slow', marketId: market.marketId, code: 'geocode.slow' });
    return 'unavailable';
  }

  /** Points kept now, expired ones included until they are dropped. */
  get size(): number {
    return this.#entries.size;
  }

  /**
   * A full address is kept per merchant, so a cache hit's speed tells no merchant which addresses
   * another one sent (Hassan L2). A postcode alone, as the marketplace quotes, is no one's
   * address and is shared.
   */
  #keyOf(
    market: MarketContext,
    address: string,
    postcode: string,
    merchantId: string | null,
  ): string {
    const place = normalisedAddress(address);
    const code = postcode.trim().toUpperCase();
    const scope = place === code.toLowerCase() ? '' : (merchantId ?? '');
    return createHmac('sha256', this.#secret)
      .update([market.marketId, scope, place, code].join('|'))
      .digest('base64url');
  }

  #cached(key: string): LocatedStop | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAtMs <= this.clock.now().epochMilliseconds) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.located;
  }

  #keep(key: string, located: LocatedStop, ttlSeconds: number): void {
    if (ttlSeconds === 0) return;
    this.#entries.delete(key);
    // Entries are in insertion order: drop expired points from the oldest end, so a point is
    // not kept in memory long after its TTL (Privacy Act).
    const nowMs = this.clock.now().epochMilliseconds;
    for (const [oldKey, entry] of this.#entries) {
      if (entry.expiresAtMs > nowMs) break;
      this.#entries.delete(oldKey);
    }
    if (this.#entries.size >= this.maxEntries) {
      // Map keeps insertion order: drop the oldest entry.
      const oldest = this.#entries.keys().next();
      if (oldest.done !== true) this.#entries.delete(oldest.value);
    }
    this.#entries.set(key, {
      located,
      expiresAtMs: this.clock.now().epochMilliseconds + ttlSeconds * 1000,
    });
  }
}
