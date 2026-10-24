import type { CallContext, GeoPoint, MarketContext } from '@mondapac-drive/shared-kernel';
import type {
  CourierAvailability,
  CourierProximity,
} from '../../src/modules/dispatch/application/ports';
import type { AvailableCourier, NearbyCourier } from '../../src/modules/dispatch/domain/matching';

/**
 * Stand-ins for fleet's `findEligibleCouriers` and tracking's `nearestCouriers` for tests:
 * couriers a test puts in, per Market. The running process binds the fleet and tracking
 * adapters instead.
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

  findEligibleCouriers(context: CallContext): Promise<readonly AvailableCourier[]> {
    return Promise.resolve(this.#available.get(context.market.marketId) ?? []);
  }

  nearestCouriers(
    context: CallContext,
    _point: GeoPoint,
    options: { readonly radiusMetres: number; readonly limit: number },
  ): Promise<readonly NearbyCourier[]> {
    const near = (this.#nearby.get(context.market.marketId) ?? [])
      .filter((c) => c.distanceMetres <= options.radiusMetres)
      .sort((a, b) => a.distanceMetres - b.distanceMetres)
      .slice(0, options.limit);
    return Promise.resolve(near);
  }
}
