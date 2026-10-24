/** Vehicle types in order of size. A Market's rate card says which of them it offers. */
export const VEHICLE_TYPES = ['bicycle', 'motorbike', 'car', 'van'] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];
