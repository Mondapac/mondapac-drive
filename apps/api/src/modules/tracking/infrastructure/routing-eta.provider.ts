import type { Clock, GeoPoint, MarketContext, Temporal } from '@mondapac-drive/shared-kernel';
import type { RoutingProvider } from '../../../platform/routing';
import type { EtaProvider, TrackingSettingsProvider } from '../application/ports';
import type { VehicleType } from '../domain/vehicle';

/** Three decimals: about 110 metres, so a moving courier does not ask for a route every ping. */
const CELL = 1000;
const cell = (point: GeoPoint) => `${Math.round(point.lat * CELL)},${Math.round(point.lng * CELL)}`;

/** Entries kept at most; the oldest go first. */
const MAX_ENTRIES = 10_000;

interface Cached {
  readonly seconds: number;
  readonly at: Temporal.Instant;
}

/**
 * {@link EtaProvider} on the platform's routing (`ROUTING_PROVIDER.route(...).durationSeconds`).
 * Every viewer of a tracking page asks again every few seconds, so answers are kept in this
 * process for the Market's `etaRefreshSeconds` per route cell (origin and destination rounded
 * to about 110 m) and vehicle, and the time since is subtracted. The keys hold rounded
 * coordinates of live location: they stay in memory, are bounded and are never logged.
 */
export class RoutingEtaProvider implements EtaProvider {
  readonly #cache = new Map<string, Cached>();

  constructor(
    private readonly routing: RoutingProvider,
    private readonly settings: TrackingSettingsProvider,
    private readonly clock: Clock,
  ) {}

  async etaSeconds(
    market: MarketContext,
    from: GeoPoint,
    to: GeoPoint,
    vehicle: VehicleType,
  ): Promise<number | undefined> {
    const now = this.clock.now();
    const key = `${market.marketId}|${vehicle}|${cell(from)}|${cell(to)}`;
    const cached = this.#cache.get(key);
    const refresh = this.settings.get(market.marketId).etaRefreshSeconds;
    if (cached !== undefined) {
      const elapsed = now.since(cached.at).total({ unit: 'seconds' });
      if (elapsed < refresh) return roundUp(Math.max(0, cached.seconds - elapsed));
      this.#cache.delete(key);
    }
    const route = await this.routing.route(market, from, to, vehicle);
    if (this.#cache.size >= MAX_ENTRIES) {
      this.#cache.delete(this.#cache.keys().next().value!);
    }
    this.#cache.set(key, { seconds: route.durationSeconds, at: now });
    return roundUp(route.durationSeconds);
  }
}

/** Whole minutes, at least one: a page shows "3 min", never "0 min" or seconds. */
function roundUp(seconds: number): number {
  return Math.max(60, Math.ceil(seconds / 60) * 60);
}
