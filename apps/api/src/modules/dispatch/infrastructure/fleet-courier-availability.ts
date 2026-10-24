import { parseId, type CallContext } from '@mondapac-drive/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { AvailableFleetVehicle, FleetDirectory } from '../../fleet';
import type { CourierAvailability } from '../application/ports';
import { isAtLeast, VEHICLE_TYPES } from '../domain/courier';
import type { AvailableCourier, DispatchRequirements } from '../domain/matching';

/** Whether the vehicle carries the parcel: its own capacity and the temperature it keeps. */
function fits(vehicle: AvailableFleetVehicle, needs: DispatchRequirements): boolean {
  return (
    vehicle.maxWeightGrams >= needs.weightGrams &&
    vehicle.maxVolumeLitres >= needs.volumeLitres &&
    vehicle.temperatures.includes(needs.temperature)
  );
}

/**
 * {@link CourierAvailability} over fleet's `FleetDirectory.findAvailableCouriers`: the couriers
 * (by identity account id) who are active, online in the service area and hold an eligible
 * vehicle (documents verified, cold box when the parcel is chilled or frozen) of a type at least
 * as large as the delivery's and offered by the Market's rate card, with fleet's idle time.
 *
 * Each courier is matched with the smallest of their vehicles that carries the parcel by its
 * own capacity; a courier none of whose vehicles carries it, or with a malformed id, is left
 * out.
 */
export class FleetCourierAvailability implements CourierAvailability {
  constructor(
    private readonly fleet: FleetDirectory,
    private readonly markets: MarketRegistry,
  ) {}

  async findEligibleCouriers(
    context: CallContext,
    needs: DispatchRequirements,
  ): Promise<readonly AvailableCourier[]> {
    const rates = this.markets.get(context.market.marketId).delivery.rateCard.vehicles;
    const vehicleTypes = VEHICLE_TYPES.filter(
      (type) => isAtLeast(type, needs.minimumVehicle) && rates[type] !== undefined,
    );
    if (vehicleTypes.length === 0) return [];
    const couriers = await this.fleet.findAvailableCouriers(context, {
      vehicleTypes,
      coldChain: needs.temperature !== 'ambient',
      serviceArea: needs.serviceAreaCode,
    });
    const found: AvailableCourier[] = [];
    for (const courier of couriers) {
      const courierId = parseId<'Courier'>(courier.courierId);
      if (!courierId.ok) continue;
      const vehicle = courier.vehicles
        .filter((v) => vehicleTypes.includes(v.type) && fits(v, needs))
        .sort((a, b) => VEHICLE_TYPES.indexOf(a.type) - VEHICLE_TYPES.indexOf(b.type))[0];
      if (vehicle === undefined) continue;
      found.push({
        courierId: courierId.value,
        vehicle: {
          type: vehicle.type,
          maxWeightGrams: vehicle.maxWeightGrams,
          maxVolumeLitres: vehicle.maxVolumeLitres,
          temperatures: vehicle.temperatures,
        },
        serviceAreaCodes: [needs.serviceAreaCode],
        idleSince: courier.idleSince,
      });
    }
    return found;
  }
}
