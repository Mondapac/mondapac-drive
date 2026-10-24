import type { GeoPoint, MarketContext } from '@mondapac-drive/shared-kernel';
import type { CourierAvailability, CourierProximity } from '../application/ports';
import type { AvailableCourier, NearbyCourier } from '../domain/matching';

/**
 * Stand-ins for fleet's `findEligibleCouriers` and tracking's `nearestCouriers` until those
 * modules are on main: couriers a test (or a seed) puts in, per Market. Empty in a running
 * process, so every job is exhausted and handed to a dispatcher until the real adapters land.
 */
export class InMemoryCouriers implements CourierAvailability, CourierProximity {
  readonly #available = new Map<string, AvailableCourier[]>();
  readonly #nearby = new Map<string, NearbyCourier[]>();

  put(market: MarketContext, courier: AvailableCourier, distanceMetres: number): void {
    const key = market.marketId;
    this.remove(market, courier.courierId);
    this.#available.set(key, [...(this.#available.get(key) ?? []), courier]);
    this.#nearby.set(key, [
      ...(this.#nearby.get(key) ?? []),
      { courierId: courier.courierId, distanceMetres },
    ]);
  }

  remove(market: MarketContext, courierId: string): void {
    const key = market.marketId;
    this.#available.set(
      key,
      (this.#available.get(key) ?? []).filter((c) => c.courierId !== courierId),
    );
    this.#nearby.set(
      key,
      (this.#nearby.get(key) ?? []).filter((c) => c.courierId !== courierId),
    );
  }

  findEligibleCouriers(market: MarketContext): Promise<readonly AvailableCourier[]> {
    return Promise.resolve(this.#available.get(market.marketId) ?? []);
  }

  nearestCouriers(
    market: MarketContext,
    _point: GeoPoint,
    options: { readonly radiusMetres: number; readonly limit: number },
  ): Promise<readonly NearbyCourier[]> {
    const near = (this.#nearby.get(market.marketId) ?? [])
      .filter((c) => c.distanceMetres <= options.radiusMetres)
      .sort((a, b) => a.distanceMetres - b.distanceMetres)
      .slice(0, options.limit);
    return Promise.resolve(near);
  }
}
