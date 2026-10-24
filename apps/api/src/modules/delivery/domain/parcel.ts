import { DeliveryDomainError } from './errors.js';

export const TEMPERATURES = ['ambient', 'chilled', 'frozen'] as const;
export type Temperature = (typeof TEMPERATURES)[number];

/** What is carried. Chilled and frozen parcels need cold-chain readings on the way. */
export interface Parcel {
  readonly weightGrams: number;
  readonly volumeLitres: number;
  readonly temperature: Temperature;
}

export function parcel(
  weightGrams: number,
  volumeLitres: number,
  temperature: Temperature,
): Parcel {
  if (!Number.isSafeInteger(weightGrams) || weightGrams <= 0) {
    throw new DeliveryDomainError(
      'parcel.invalid-weight',
      'Weight must be a positive whole number of grams',
    );
  }
  if (!Number.isSafeInteger(volumeLitres) || volumeLitres <= 0) {
    throw new DeliveryDomainError(
      'parcel.invalid-volume',
      'Volume must be a positive whole number of litres',
    );
  }
  return { weightGrams, volumeLitres, temperature };
}

export function needsColdChain(temperature: Temperature): temperature is 'chilled' | 'frozen' {
  return temperature !== 'ambient';
}
