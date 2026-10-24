/**
 * The vehicle types of the delivery module, repeated here because a module never imports
 * another's domain. A Market's tracking settings give each offered vehicle an ETA speed.
 */
export const VEHICLE_TYPES = ['bicycle', 'motorbike', 'car', 'van'] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];
