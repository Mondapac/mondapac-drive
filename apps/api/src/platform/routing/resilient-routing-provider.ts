import { Logger } from '@nestjs/common';
import type { Clock, GeoPoint, MarketContext, MarketId } from '@mondapac-drive/shared-kernel';
import { CircuitBreaker } from './circuit-breaker';
import type { GoogleRoutesClient } from './google-routes-client';
import { GoogleRoutingError, NoRouteError, type RoadLeg } from './google-routes-client';
import { routeCacheKey, type RouteCache } from './route-cache';
import type { RoutingConfig, RoutingVehicleType } from './routing-config';
import {
  checkAddressQuery,
  GeocodingUnavailableError,
  type AddressQuery,
  InvalidMatrixRequestError,
  MAX_MATRIX_CELLS,
  type GeocodedAddress,
  type RouteEstimate,
  type RoutingProvider,
} from './routing-provider';
import { StraightLineRouter } from './straight-line-router';

/** One Market's routing: its configuration, its road client (if any) and its breaker. */
export interface MarketRouting {
  readonly config: RoutingConfig;
  /** Undefined when the Market routes by straight line only. */
  readonly road: GoogleRoutesClient | undefined;
  /** The secret of the Market's cache keys (its provider key); set whenever `road` is. */
  readonly cacheSecret?: string;
}

interface MarketState {
  readonly config: RoutingConfig;
  readonly road: GoogleRoutesClient | undefined;
  readonly cacheSecret: string;
  readonly straightLine: StraightLineRouter;
  readonly breaker: CircuitBreaker;
}

/**
 * The {@link RoutingProvider} of the application: the Market's road client behind a cache and a
 * circuit breaker, with the straight-line estimate whenever the road answer is unavailable.
 * Logs carry the Market and an error code only, never a coordinate or an address.
 */
export class ResilientRoutingProvider implements RoutingProvider {
  private readonly logger = new Logger('Routing');
  readonly #markets = new Map<MarketId, MarketState>();

  constructor(
    markets: ReadonlyMap<MarketId, MarketRouting>,
    private readonly cache: RouteCache,
    clock: Clock,
  ) {
    for (const [marketId, { config, road, cacheSecret }] of markets) {
      this.#markets.set(marketId, {
        config,
        road,
        cacheSecret: cacheSecret ?? '',
        straightLine: new StraightLineRouter(config.straightLine),
        breaker: new CircuitBreaker(
          clock,
          config.circuitBreaker.failureThreshold,
          config.circuitBreaker.openSeconds,
        ),
      });
    }
  }

  async route(
    market: MarketContext,
    origin: GeoPoint,
    destination: GeoPoint,
    vehicle: RoutingVehicleType,
  ): Promise<RouteEstimate> {
    const state = this.#state(market.marketId);
    const fallback = () => state.straightLine.route(origin, destination, vehicle);
    if (state.road === undefined) return fallback();

    const key = this.#key(market.marketId, state, origin, destination, vehicle);
    const cached = await this.#cacheGet(market.marketId, state, key);
    if (cached !== undefined) return cached;

    const road = state.road;
    const leg = await this.#guarded(market.marketId, state, () =>
      road.route(origin, destination, vehicle),
    );
    if (leg === undefined) return fallback();
    await this.#cacheSet(market.marketId, state, key, leg);
    return { ...leg, source: 'road' };
  }

  async matrix(
    market: MarketContext,
    origins: readonly GeoPoint[],
    destinations: readonly GeoPoint[],
    vehicle: RoutingVehicleType,
  ): Promise<RouteEstimate[][]> {
    if (origins.length * destinations.length > MAX_MATRIX_CELLS) {
      throw new InvalidMatrixRequestError('too-large');
    }
    const state = this.#state(market.marketId);
    if (origins.length === 0 || destinations.length === 0 || state.road === undefined) {
      return state.straightLine.matrix(origins, destinations, vehicle);
    }

    const keys = origins.map((origin) =>
      destinations.map((destination) =>
        this.#key(market.marketId, state, origin, destination, vehicle),
      ),
    );
    const cells: (RouteEstimate | undefined)[][] = [];
    for (const row of keys) {
      cells.push(await Promise.all(row.map((key) => this.#cacheGet(market.marketId, state, key))));
    }

    if (cells.some((row) => row.includes(undefined))) {
      const road = state.road;
      const legs = await this.#guarded(market.marketId, state, () =>
        road.matrix(origins, destinations, vehicle),
      );
      for (const [i, row] of cells.entries()) {
        for (const [j, cell] of row.entries()) {
          if (cell !== undefined) continue;
          const leg = legs?.[i]?.[j];
          if (leg === undefined) continue;
          row[j] = { ...leg, source: 'road' };
          await this.#cacheSet(market.marketId, state, keys[i]![j]!, leg);
        }
      }
    }

    return cells.map((row, i) =>
      row.map(
        (cell, j) => cell ?? state.straightLine.route(origins[i]!, destinations[j]!, vehicle),
      ),
    );
  }

  async geocode(market: MarketContext, query: AddressQuery): Promise<GeocodedAddress | undefined> {
    checkAddressQuery(query);
    const state = this.#state(market.marketId);
    const road = state.road;
    if (road === undefined) throw new GeocodingUnavailableError('routing.geocoding-unconfigured');
    if (!state.breaker.tryAcquire()) throw new GeocodingUnavailableError('routing.provider-failed');
    try {
      const found = await road.geocode(query.address.trim(), query.postcode);
      const result =
        found === undefined && query.postcode !== undefined
          ? await road.geocodePostcode(query.postcode)
          : found;
      state.breaker.recordSuccess();
      return result;
    } catch (error) {
      if (!(error instanceof GoogleRoutingError)) {
        state.breaker.recordNeutral();
        throw error;
      }
      if (error.code === 'routing.provider-rejected') state.breaker.recordNeutral();
      else state.breaker.recordFailure();
      this.logger.warn({
        msg: 'geocoding failed',
        marketId: market.marketId,
        code: error.code,
        status: error.status,
      });
      throw new GeocodingUnavailableError('routing.provider-failed');
    }
  }

  /** Closes the cache connection (module shutdown). */
  close(): Promise<void> {
    return this.cache.close();
  }

  #state(marketId: MarketId): MarketState {
    const state = this.#markets.get(marketId);
    // A MarketContext is minted only for a hosted Market, and every hosted Market has a state.
    if (state === undefined) throw new Error(`Routing has no state for market "${marketId}"`);
    return state;
  }

  #key(
    marketId: MarketId,
    state: MarketState,
    origin: GeoPoint,
    destination: GeoPoint,
    vehicle: RoutingVehicleType,
  ): string {
    return routeCacheKey(
      marketId,
      origin,
      destination,
      vehicle,
      state.config.cacheCoordinateDecimals,
      state.cacheSecret,
    );
  }

  /** Calls the road provider unless the breaker is open; undefined means "use the fallback". */
  async #guarded<T>(
    marketId: MarketId,
    state: MarketState,
    call: () => Promise<T>,
  ): Promise<T | undefined> {
    if (!state.breaker.tryAcquire()) {
      this.logger.debug({ msg: 'straight-line fallback', marketId, code: 'routing.circuit-open' });
      return undefined;
    }
    try {
      const result = await call();
      state.breaker.recordSuccess();
      return result;
    } catch (error) {
      if (error instanceof NoRouteError) {
        // The provider is up; it found no road between the points.
        state.breaker.recordSuccess();
        this.logger.warn({ msg: 'straight-line fallback', marketId, code: 'routing.no-route' });
        return undefined;
      }
      if (!(error instanceof GoogleRoutingError)) {
        state.breaker.recordNeutral();
        throw error;
      }
      if (error.code === 'routing.provider-rejected') state.breaker.recordNeutral();
      else state.breaker.recordFailure();
      this.logger.warn({
        msg: 'straight-line fallback',
        marketId,
        code: error.code,
        status: error.status,
        breaker: state.breaker.state,
      });
      return undefined;
    }
  }

  async #cacheGet(
    marketId: MarketId,
    state: MarketState,
    key: string,
  ): Promise<RouteEstimate | undefined> {
    if (state.config.cacheTtlSeconds === 0 || state.cacheSecret === '') return undefined;
    try {
      const cached = await this.cache.get(key);
      return cached === undefined ? undefined : { ...cached, source: 'road' };
    } catch {
      this.logger.warn({
        msg: 'route cache unavailable',
        marketId,
        code: 'routing.cache-read-failed',
      });
      return undefined;
    }
  }

  async #cacheSet(
    marketId: MarketId,
    state: MarketState,
    key: string,
    leg: RoadLeg,
  ): Promise<void> {
    if (state.config.cacheTtlSeconds === 0 || state.cacheSecret === '') return;
    try {
      await this.cache.set(key, leg, state.config.cacheTtlSeconds);
    } catch {
      this.logger.warn({
        msg: 'route cache unavailable',
        marketId,
        code: 'routing.cache-write-failed',
      });
    }
  }
}
