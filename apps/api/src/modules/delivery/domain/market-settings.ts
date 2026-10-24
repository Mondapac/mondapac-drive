import type { MarketId } from '@mondapac-drive/shared-kernel';
import type { Temperature } from './parcel.js';
import type { ServiceArea } from './service-area.js';
import type { VehicleType } from './vehicle.js';

/** One vehicle's prices and limits. Money values are minor units of the Market's currency. */
export interface VehicleRate {
  readonly baseFee: number;
  readonly perKm: number;
  readonly maxDistanceMetres: number;
  readonly maxWeightGrams: number;
  readonly maxVolumeLitres: number;
  readonly temperatures: readonly Temperature[];
}

/** Everything about delivery that differs by Market (config/markets/<CODE>.json). */
export interface MarketDeliverySettings {
  readonly marketId: MarketId;
  readonly currency: string;
  readonly timezone: string;
  readonly pricesIncludeTax: boolean;
  readonly taxRateBps: number;
  readonly serviceAreas: readonly ServiceArea[];
  readonly rateCard: {
    readonly vehicles: Partial<Record<VehicleType, VehicleRate>>;
    readonly coldChainSurcharge: Record<Temperature, number>;
    readonly scheduledDiscountBps: number;
  };
  readonly coldChain: Record<'chilled' | 'frozen', { readonly maxCelsius: number }>;
  readonly scheduling: {
    readonly minLeadMinutes: number;
    readonly maxDaysAhead: number;
    readonly minWindowMinutes: number;
  };
}
