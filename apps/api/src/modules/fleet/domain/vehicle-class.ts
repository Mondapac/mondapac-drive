import { FleetDomainError } from './errors';
import type { MarketFleetRules } from './fleet-rules';
import type { ColdBox, Temperature, Vehicle, VehicleCapacity, VehicleType } from './vehicle';

/**
 * The capacity of a new vehicle of `type`: the one given, or the Market rate card's for the type.
 * A type the Market does not offer has no default, and is refused.
 */
export function capacityFor(
  type: VehicleType,
  given: Partial<VehicleCapacity>,
  rules: MarketFleetRules,
): VehicleCapacity {
  const vehicleClass = rules.vehicleClasses[type];
  if (vehicleClass === undefined) {
    throw new FleetDomainError('fleet.vehicle.type-not-offered', 'The Market has no such vehicle');
  }
  return {
    maxWeightGrams: given.maxWeightGrams ?? vehicleClass.maxWeightGrams,
    maxVolumeLitres: given.maxVolumeLitres ?? vehicleClass.maxVolumeLitres,
  };
}

/** The temperatures each box keeps goods at. */
const BOX_TEMPERATURES: Readonly<Record<ColdBox, readonly Temperature[]>> = {
  none: ['ambient'],
  insulated: ['ambient', 'chilled'],
  refrigerated: ['ambient', 'chilled', 'frozen'],
};

/**
 * The temperatures a vehicle can carry goods at: what its box keeps, and what the Market lets its
 * type carry. Whether the courier may carry cold chain at all is the eligibility's question.
 */
export function vehicleTemperatures(vehicle: Vehicle, rules: MarketFleetRules): Temperature[] {
  const allowed = rules.vehicleClasses[vehicle.type]?.temperatures ?? [];
  return BOX_TEMPERATURES[vehicle.coldBox].filter((temperature) => allowed.includes(temperature));
}
