import { parseId, type CallContext, type GeoPoint } from '@mondapac-drive/shared-kernel';
import type { NearestCouriers } from '../../tracking';
import type { CourierProximity } from '../application/ports';
import type { NearbyCourier } from '../domain/matching';

/**
 * {@link CourierProximity} over tracking's `NearestCouriers`: couriers with a fresh live
 * position in the service area, nearest first. Tracking caps the radius and the count by the
 * Market's settings. A position whose courier id is not a UUIDv7 is dropped.
 */
export class TrackingCourierProximity implements CourierProximity {
  constructor(private readonly nearest: NearestCouriers) {}

  async nearestCouriers(
    context: CallContext,
    point: GeoPoint,
    options: {
      readonly radiusMetres: number;
      readonly limit: number;
      readonly serviceArea: string;
    },
  ): Promise<readonly NearbyCourier[]> {
    const found = await this.nearest.perform(
      context.market,
      point,
      options.radiusMetres,
      options.limit,
      { serviceArea: options.serviceArea },
    );
    const nearby: NearbyCourier[] = [];
    for (const { position, distanceMetres } of found) {
      const courierId = parseId<'Courier'>(position.courierId);
      if (courierId.ok) nearby.push({ courierId: courierId.value, distanceMetres });
    }
    return nearby;
  }
}
