import {
  Temporal,
  type Clock,
  type GeoPoint,
  type MarketContext,
} from '@mondapac-drive/shared-kernel';
import type { LivePositionStore } from '../application/ports';
import { straightLineMetres } from '../domain/geo-distance';
import type { LivePosition, NearbyCourier } from '../domain/live-position';

/** One key per Market, tenant and courier, as the Redis store's hash tag. */
const scoped = (market: MarketContext, courierId: string) =>
  `${market.marketId}:${market.tenantId}:${courierId}`;

interface Entry<T> {
  readonly value: T;
  readonly expiresAt: Temporal.Instant;
}

/**
 * {@link LivePositionStore} in this process, for development and tests without Redis. It
 * keeps the same rules as the Redis store (TTL, later reading wins, per-area search) with time
 * from the injected Clock. Refused in production: each API instance would see other couriers.
 */
export class InMemoryLivePositionStore implements LivePositionStore {
  readonly #positions = new Map<string, Entry<LivePosition>>();
  readonly #slots = new Map<string, Entry<true>>();

  constructor(private readonly clock: Clock) {}

  claimPingSlot(
    market: MarketContext,
    courierId: string,
    intervalSeconds: number,
  ): Promise<boolean> {
    const key = scoped(market, courierId);
    if (this.#live(this.#slots.get(key)) !== undefined) return Promise.resolve(false);
    this.#slots.set(key, { value: true, expiresAt: this.#in(intervalSeconds) });
    return Promise.resolve(true);
  }

  save(market: MarketContext, position: LivePosition, ttlSeconds: number): Promise<boolean> {
    const key = scoped(market, position.courierId);
    const current = this.#live(this.#positions.get(key));
    if (
      current !== undefined &&
      Temporal.Instant.compare(current.recordedAt, position.recordedAt) >= 0
    ) {
      return Promise.resolve(false);
    }
    this.#positions.set(key, { value: position, expiresAt: this.#in(ttlSeconds) });
    return Promise.resolve(true);
  }

  lastKnown(market: MarketContext, courierId: string): Promise<LivePosition | undefined> {
    return Promise.resolve(this.#live(this.#positions.get(scoped(market, courierId))));
  }

  nearest(
    market: MarketContext,
    point: GeoPoint,
    radiusMetres: number,
    limit: number,
    serviceAreaCode?: string,
  ): Promise<NearbyCourier[]> {
    const nearby: NearbyCourier[] = [];
    for (const [key, entry] of this.#positions) {
      const position = this.#live(entry);
      if (position === undefined || !key.startsWith(scoped(market, ''))) continue;
      if (serviceAreaCode !== undefined && position.serviceAreaCode !== serviceAreaCode) continue;
      const distanceMetres = straightLineMetres(point, position.point);
      if (distanceMetres <= radiusMetres) nearby.push({ position, distanceMetres });
    }
    nearby.sort((a, b) => a.distanceMetres - b.distanceMetres);
    return Promise.resolve(nearby.slice(0, limit));
  }

  #in(seconds: number): Temporal.Instant {
    return this.clock.now().add({ seconds });
  }

  #live<T>(entry: Entry<T> | undefined): T | undefined {
    if (entry === undefined) return undefined;
    return Temporal.Instant.compare(this.clock.now(), entry.expiresAt) < 0
      ? entry.value
      : undefined;
  }
}
