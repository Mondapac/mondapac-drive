import { Temporal, type GeoPoint, type Id } from '@mondapac-drive/shared-kernel';
import { isAtLeast, type Temperature, type VehicleType } from './courier';

/** What a delivery needs from the courier who carries it. */
export interface DispatchRequirements {
  readonly serviceAreaCode: string;
  readonly pickup: GeoPoint;
  /** The vehicle the delivery was priced for; a larger vehicle may carry it too. */
  readonly minimumVehicle: VehicleType;
  readonly weightGrams: number;
  readonly volumeLitres: number;
  readonly temperature: Temperature;
}

/** A courier who is on shift and free, with what their vehicle can carry (fleet). */
export interface AvailableCourier {
  readonly courierId: Id<'Courier'>;
  readonly vehicle: {
    readonly type: VehicleType;
    readonly maxWeightGrams: number;
    readonly maxVolumeLitres: number;
    /** The temperatures the vehicle's equipment keeps: chilled and frozen need cold-chain gear. */
    readonly temperatures: readonly Temperature[];
  };
  readonly serviceAreaCodes: readonly string[];
  /** Since when the courier has had no delivery; the longest idle goes first on a tie. */
  readonly idleSince: Temporal.Instant;
}

/** A courier's last known distance from the pickup (tracking). */
export interface NearbyCourier {
  readonly courierId: Id<'Courier'>;
  readonly distanceMetres: number;
}

/** A courier who may be offered the delivery, in offer order. */
export interface RankedCandidate {
  readonly courierId: Id<'Courier'>;
  readonly vehicle: VehicleType;
  readonly distanceMetres: number;
}

/** Whether a courier's vehicle, equipment and service areas fit the delivery. */
export function canCarry(courier: AvailableCourier, needs: DispatchRequirements): boolean {
  const { vehicle } = courier;
  return (
    isAtLeast(vehicle.type, needs.minimumVehicle) &&
    vehicle.maxWeightGrams >= needs.weightGrams &&
    vehicle.maxVolumeLitres >= needs.volumeLitres &&
    vehicle.temperatures.includes(needs.temperature) &&
    courier.serviceAreaCodes.includes(needs.serviceAreaCode)
  );
}

/**
 * The couriers to offer the delivery to, best first: those who are both available and near,
 * can carry the parcel, are within the search radius and are not excluded (already offered,
 * or dropped this delivery). Ranked by distance, then by idle time (longest idle first), then
 * by courier id so that the order never depends on the order of the inputs.
 */
export function rankCandidates(
  needs: DispatchRequirements,
  available: readonly AvailableCourier[],
  nearby: readonly NearbyCourier[],
  options: { readonly searchRadiusMetres: number; readonly exclude: ReadonlySet<string> },
): RankedCandidate[] {
  const distances = new Map<string, number>();
  for (const near of nearby) {
    const known = distances.get(near.courierId);
    if (known === undefined || near.distanceMetres < known) {
      distances.set(near.courierId, near.distanceMetres);
    }
  }
  const ranked: (RankedCandidate & { readonly idleSince: Temporal.Instant })[] = [];
  const seen = new Set<string>();
  for (const courier of available) {
    if (seen.has(courier.courierId) || options.exclude.has(courier.courierId)) continue;
    seen.add(courier.courierId);
    const distanceMetres = distances.get(courier.courierId);
    if (distanceMetres === undefined || distanceMetres > options.searchRadiusMetres) continue;
    if (!canCarry(courier, needs)) continue;
    ranked.push({
      courierId: courier.courierId,
      vehicle: courier.vehicle.type,
      distanceMetres,
      idleSince: courier.idleSince,
    });
  }
  ranked.sort(
    (a, b) =>
      a.distanceMetres - b.distanceMetres ||
      Temporal.Instant.compare(a.idleSince, b.idleSince) ||
      (a.courierId < b.courierId ? -1 : a.courierId > b.courierId ? 1 : 0),
  );
  return ranked.map(({ courierId, vehicle, distanceMetres }) => ({
    courierId,
    vehicle,
    distanceMetres,
  }));
}
