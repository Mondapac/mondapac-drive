import type { Id } from '@mondapac-drive/shared-kernel';
import { FleetDomainError } from './errors';

/**
 * Vehicle types in order of size: the same list as the delivery module's `vehicle.ts` (and the
 * platform's Market configuration), copied because a domain imports no other module. A spec
 * keeps the copies equal.
 */
export const VEHICLE_TYPES = ['bicycle', 'motorbike', 'car', 'van'] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

/** A temperature goods travel at: the delivery module's list, copied like the vehicle types. */
export const TEMPERATURES = ['ambient', 'chilled', 'frozen'] as const;
export type Temperature = (typeof TEMPERATURES)[number];

/** The box a vehicle carries goods in. Only an insulated or refrigerated box carries cold chain. */
export const COLD_BOXES = ['none', 'insulated', 'refrigerated'] as const;
export type ColdBox = (typeof COLD_BOXES)[number];

export interface Vehicle {
  readonly id: Id<'Vehicle'>;
  readonly type: VehicleType;
  /** Upper case letters and digits, as on the plate; a bicycle has none. */
  readonly plate?: string;
  readonly maxWeightGrams: number;
  readonly maxVolumeLitres: number;
  readonly coldBox: ColdBox;
  readonly active: boolean;
}

export interface NewVehicle {
  readonly id: Id<'Vehicle'>;
  readonly type: VehicleType;
  readonly plate?: string;
  readonly maxWeightGrams: number;
  readonly maxVolumeLitres: number;
  readonly coldBox: ColdBox;
}

/** What a vehicle carries: its own measure, or the Market rate card's default for its type. */
export interface VehicleCapacity {
  readonly maxWeightGrams: number;
  readonly maxVolumeLitres: number;
}

const PLATE = /^[A-Z0-9]{1,10}$/;
const MAX_WEIGHT_GRAMS = 5_000_000;
const MAX_VOLUME_LITRES = 50_000;

/** A plate as stored: upper case, without spaces or dashes. */
export function normalisePlate(plate: string): string {
  return plate.replaceAll(/[\s-]/g, '').toUpperCase();
}

export function newVehicle(input: NewVehicle): Vehicle {
  if (!(VEHICLE_TYPES as readonly string[]).includes(input.type)) {
    throw new FleetDomainError('fleet.vehicle.type-unknown', 'Unknown vehicle type');
  }
  if (!(COLD_BOXES as readonly string[]).includes(input.coldBox)) {
    throw new FleetDomainError('fleet.vehicle.cold-box-unknown', 'Unknown cold box');
  }
  const plate = input.plate === undefined ? undefined : normalisePlate(input.plate);
  if (plate !== undefined && !PLATE.test(plate)) {
    throw new FleetDomainError(
      'fleet.vehicle.plate-invalid',
      'A plate is 1 to 10 letters or digits',
    );
  }
  if (plate === undefined && input.type !== 'bicycle') {
    throw new FleetDomainError('fleet.vehicle.plate-required', 'A motor vehicle needs its plate');
  }
  checkCapacity(input);
  return {
    id: input.id,
    type: input.type,
    ...(plate === undefined ? {} : { plate }),
    maxWeightGrams: input.maxWeightGrams,
    maxVolumeLitres: input.maxVolumeLitres,
    coldBox: input.coldBox,
    active: true,
  };
}

/** Refuses a capacity out of range: whole grams and litres, above zero, below a sane bound. */
export function checkCapacity(capacity: VehicleCapacity): void {
  if (!isPositiveUpTo(capacity.maxWeightGrams, MAX_WEIGHT_GRAMS)) {
    throw new FleetDomainError('fleet.vehicle.capacity-invalid', 'Weight capacity out of range');
  }
  if (!isPositiveUpTo(capacity.maxVolumeLitres, MAX_VOLUME_LITRES)) {
    throw new FleetDomainError('fleet.vehicle.capacity-invalid', 'Volume capacity out of range');
  }
}

/** True when the vehicle can keep chilled or frozen goods cold. */
export function carriesColdChain(vehicle: Vehicle): boolean {
  return vehicle.coldBox !== 'none';
}

function isPositiveUpTo(value: number, max: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= max;
}
