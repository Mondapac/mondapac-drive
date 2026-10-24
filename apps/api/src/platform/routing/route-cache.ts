import { createHmac } from 'node:crypto';
import type { Clock, GeoPoint, MarketId } from '@mondapac-drive/shared-kernel';
import type { RoutingVehicleType } from './routing-config';

/** What the cache keeps of a road route. Straight-line estimates are never cached. */
export interface CachedRoute {
  readonly distanceMetres: number;
  readonly durationSeconds: number;
}

/**
 * Road routes by rounded coordinates and vehicle. A cache failure must never fail a route: the
 * provider catches and logs it, and asks the road provider instead.
 */
export interface RouteCache {
  get(key: string): Promise<CachedRoute | undefined>;
  set(key: string, route: CachedRoute, ttlSeconds: number): Promise<void>;
  close(): Promise<void>;
}

/** Every key of this package starts with it (handoff 00: Redis keys are owned by prefix). */
export const ROUTE_CACHE_PREFIX = 'routing:route:v1:';

/**
 * The cache key of a leg: an HMAC of the rounded coordinates under a secret (the Market's
 * provider key). A plain hash of rounded coordinates could be brute-forced back to a customer
 * location; without the secret, the key reveals nothing (Privacy Act: coordinates are personal
 * data). Rotating the secret only empties the cache.
 */
export function routeCacheKey(
  market: MarketId,
  origin: GeoPoint,
  destination: GeoPoint,
  vehicle: RoutingVehicleType,
  decimals: number,
  secret: string,
): string {
  const round = (value: number) => value.toFixed(decimals);
  const leg = [
    vehicle,
    round(origin.lat),
    round(origin.lng),
    round(destination.lat),
    round(destination.lng),
  ];
  const digest = createHmac('sha256', secret).update(leg.join('|')).digest('base64url');
  return `${ROUTE_CACHE_PREFIX}${market}:${digest}`;
}

/** Bounds a stored value must keep, so a poisoned entry cannot inflate a price or an ETA. */
export const MAX_CACHED_DISTANCE_METRES = 2_000_000;
export const MAX_CACHED_DURATION_SECONDS = 48 * 3600;

/** Parses a stored value; anything malformed or out of bounds counts as a miss. */
export function decodeCachedRoute(raw: string | null | undefined): CachedRoute | undefined {
  if (raw === null || raw === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return undefined;
    const { distanceMetres, durationSeconds } = value as Record<string, unknown>;
    if (
      !isNonNegativeInteger(distanceMetres) ||
      !isNonNegativeInteger(durationSeconds) ||
      distanceMetres > MAX_CACHED_DISTANCE_METRES ||
      durationSeconds > MAX_CACHED_DURATION_SECONDS
    ) {
      return undefined;
    }
    return { distanceMetres, durationSeconds };
  } catch {
    return undefined;
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** The cache of one process, for a stack without Redis (local runs and the HTTP suites). */
export class InMemoryRouteCache implements RouteCache {
  readonly #entries = new Map<string, { route: CachedRoute; expiresAtMs: number }>();

  constructor(
    private readonly clock: Clock,
    private readonly maxEntries = 10_000,
  ) {}

  get(key: string): Promise<CachedRoute | undefined> {
    const entry = this.#entries.get(key);
    if (entry === undefined) return Promise.resolve(undefined);
    if (entry.expiresAtMs <= this.clock.now().epochMilliseconds) {
      this.#entries.delete(key);
      return Promise.resolve(undefined);
    }
    return Promise.resolve(entry.route);
  }

  set(key: string, route: CachedRoute, ttlSeconds: number): Promise<void> {
    this.#entries.delete(key);
    if (this.#entries.size >= this.maxEntries) {
      // Map keeps insertion order: drop the oldest entry.
      const oldest = this.#entries.keys().next();
      if (oldest.done !== true) this.#entries.delete(oldest.value);
    }
    this.#entries.set(key, {
      route,
      expiresAtMs: this.clock.now().epochMilliseconds + ttlSeconds * 1000,
    });
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.#entries.clear();
    return Promise.resolve();
  }
}

/** The part of an ioredis client the cache uses, so tests can pass a fake. */
export interface RedisCommands {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
  quit(): Promise<unknown>;
}

/** The shared cache of every API and worker process, in Redis with a TTL per key. */
export class RedisRouteCache implements RouteCache {
  constructor(private readonly redis: RedisCommands) {}

  async get(key: string): Promise<CachedRoute | undefined> {
    return decodeCachedRoute(await this.redis.get(key));
  }

  async set(key: string, route: CachedRoute, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, JSON.stringify(route), 'EX', ttlSeconds);
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
