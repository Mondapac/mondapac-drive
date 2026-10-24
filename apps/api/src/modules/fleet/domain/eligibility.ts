import type { Temporal } from '@mondapac-drive/shared-kernel';
import type { CourierState } from './courier-state';
import { requirementApplies, requirementMet } from './documents';
import type { MarketFleetRules } from './fleet-rules';
import { carriesColdChain, type Vehicle, type VehicleType } from './vehicle';

/**
 * The active vehicles a courier may drive now: every document the Market requires for that
 * courier and vehicle is verified and unexpired at `now`. For a cold-chain job the courier must
 * be cold-chain capable, the vehicle must have an insulated or refrigerated box, and the
 * cold-chain documents (food handling in AU) count too.
 */
export function eligibleVehicles(
  courier: CourierState,
  rules: MarketFleetRules,
  now: Temporal.Instant,
  coldChain: boolean,
): Vehicle[] {
  if (coldChain && !courier.coldChainCapable) return [];
  return courier.vehicles.filter(
    (vehicle) =>
      vehicle.active &&
      (!coldChain || carriesColdChain(vehicle)) &&
      rules.documents.every(
        (requirement) =>
          !requirementApplies(requirement, courier.employmentType, vehicle, coldChain) ||
          requirementMet(requirement, courier.documents, vehicle, now),
      ),
  );
}

/** The vehicle types the courier is eligible for now, smallest first, without repeats. */
export function eligibleVehicleTypes(
  courier: CourierState,
  rules: MarketFleetRules,
  now: Temporal.Instant,
  coldChain: boolean,
): VehicleType[] {
  return [...new Set(eligibleVehicles(courier, rules, now, coldChain).map((v) => v.type))];
}

/** What dispatch asks for: a vehicle type it can use, cold chain or not, in one service area. */
export interface DispatchNeed {
  readonly vehicleTypes: readonly VehicleType[];
  readonly coldChain: boolean;
  readonly serviceAreaCode: string;
}

/** An active, online courier of the area with an eligible vehicle of one of the asked types. */
export function canTakeWork(
  courier: CourierState,
  need: DispatchNeed,
  rules: MarketFleetRules,
  now: Temporal.Instant,
): boolean {
  return (
    courier.status === 'active' &&
    courier.shift === 'online' &&
    courier.serviceAreaCode === need.serviceAreaCode &&
    eligibleVehicles(courier, rules, now, need.coldChain).some((vehicle) =>
      need.vehicleTypes.includes(vehicle.type),
    )
  );
}
