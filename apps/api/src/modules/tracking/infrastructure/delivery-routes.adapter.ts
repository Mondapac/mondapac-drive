import type { CallContext, Id } from '@mondapac-drive/shared-kernel';
import type { DeliveryDispatchView } from '../../delivery';
import type { DeliveryRoutes } from '../application/ports';
import type { DeliveryRoute } from '../domain/tracked-delivery';
import { VEHICLE_TYPES, type VehicleType } from '../domain/vehicle';

const isVehicle = (value: string): value is VehicleType =>
  (VEHICLE_TYPES as readonly string[]).includes(value);

/**
 * {@link DeliveryRoutes} over delivery's `DeliveryDispatchView` (system context): the pickup and
 * drop-off points and the quoted vehicle. Addresses and postcodes are not kept.
 */
export class DeliveryDispatchRoutes implements DeliveryRoutes {
  constructor(private readonly view: DeliveryDispatchView) {}

  async routeOf(
    context: CallContext,
    deliveryId: Id<'Delivery'>,
  ): Promise<DeliveryRoute | undefined> {
    const found = await this.view.forDispatch(context, deliveryId);
    if (found === undefined) return undefined;
    return {
      pickup: found.pickup.point,
      dropoff: found.dropoff.point,
      ...(isVehicle(found.vehicle) ? { vehicle: found.vehicle } : {}),
    };
  }
}
