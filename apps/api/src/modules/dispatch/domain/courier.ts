/** Vehicle types in order of size; the same codes as the delivery module's rate card. */
export const VEHICLE_TYPES = ['bicycle', 'motorbike', 'car', 'van'] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

export const TEMPERATURES = ['ambient', 'chilled', 'frozen'] as const;
export type Temperature = (typeof TEMPERATURES)[number];

/** Whether `vehicle` is at least as large as `minimum`. */
export function isAtLeast(vehicle: VehicleType, minimum: VehicleType): boolean {
  return VEHICLE_TYPES.indexOf(vehicle) >= VEHICLE_TYPES.indexOf(minimum);
}
