import { Temporal, type CallContext } from '@mondapac-drive/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { FleetDirectory } from '../../fleet';
import type { CourierAvailability } from '../application/ports';
import { isAtLeast, VEHICLE_TYPES, type Temperature, type VehicleType } from '../domain/courier';
import type { AvailableCourier, DispatchRequirements } from '../domain/matching';

/** Fleet does not report idle time yet: every courier ties, and the courier id decides. */
const UNKNOWN_IDLE_SINCE = Temporal.Instant.fromEpochMilliseconds(0);

/**
 * {@link CourierAvailability} over fleet's `FleetDirectory`: the couriers who are active,
 * online in the service area, and hold an eligible vehicle (documents verified, cold box when
 * the parcel is chilled or frozen) of a type at least as large as the delivery's.
 *
 * Fleet answers ids only, so fleet is asked once per vehicle type, smallest first, and each
 * courier gets the smallest type they are eligible for. Fleet does not expose a vehicle's
 * capacity, so the Market rate card's limits for that type stand in. They are at least the
 * quoted vehicle's, which the parcel already fits. A type the Market's rate card does not
 * offer is not asked for.
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
    const temperatures: Temperature[] =
      needs.temperature === 'ambient' ? ['ambient'] : ['ambient', needs.temperature];
    const found: AvailableCourier[] = [];
    const seen = new Set<string>();
    for (const type of VEHICLE_TYPES.filter((t) => isAtLeast(t, needs.minimumVehicle))) {
      const rate = rates[type];
      if (rate === undefined) continue;
      const ids = await this.fleet.findEligibleCouriers(context, {
        vehicleTypes: [type],
        coldChain: needs.temperature !== 'ambient',
        serviceArea: needs.serviceAreaCode,
      });
      for (const courierId of ids) {
        if (seen.has(courierId)) continue;
        seen.add(courierId);
        found.push({
          courierId,
          vehicle: {
            type: type satisfies VehicleType,
            maxWeightGrams: rate.maxWeightGrams,
            maxVolumeLitres: rate.maxVolumeLitres,
            temperatures,
          },
          serviceAreaCodes: [needs.serviceAreaCode],
          idleSince: UNKNOWN_IDLE_SINCE,
        });
      }
    }
    return found;
  }
}
