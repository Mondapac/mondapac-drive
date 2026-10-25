import type { MarketId } from '@mondapac-drive/shared-kernel';
import type { Temperature } from './parcel';
import type { VehicleType } from './vehicle';

/** One vehicle's prices and limits. Money values are minor units of the Market's currency. */
export interface VehicleRate {
  readonly baseFee: number;
  readonly perKm: number;
  readonly maxDistanceMetres: number;
  readonly maxWeightGrams: number;
  readonly maxVolumeLitres: number;
  readonly temperatures: readonly Temperature[];
}

/**
 * Everything about delivery that differs by Market: the `delivery` and `tax` sections and the
 * conventions of `config/markets/<CODE>.json`, read through the platform's MarketRegistry.
 */
export interface MarketDeliverySettings {
  readonly marketId: MarketId;
  readonly currency: string;
  readonly timezone: string;
  readonly pricesIncludeTax: boolean;
  readonly taxRateBps: number;
  readonly rateCard: {
    readonly vehicles: Partial<Record<VehicleType, VehicleRate>>;
    readonly coldChainSurcharge: Readonly<Record<Temperature, number>>;
    readonly scheduledDiscountBps: number;
  };
  readonly coldChain: Readonly<Record<'chilled' | 'frozen', { readonly maxCelsius: number }>>;
  readonly scheduling: {
    readonly minLeadMinutes: number;
    readonly maxDaysAhead: number;
    readonly minWindowMinutes: number;
  };
  readonly proofOfDelivery: {
    /** Digits of the recipient's PIN. */
    readonly pinLength: number;
    /** Wrong PINs a delivery takes before only a photo proves the hand-over. */
    readonly maxPinAttempts: number;
  };
  /** How long a quote or a booking waits on the map provider (config `delivery.responseBudget`). */
  readonly responseBudget: {
    readonly geocodeMs: number;
    readonly routeMs: number;
    /** Road distance over straight-line distance, for a distance estimated without a route. */
    readonly estimateRoadFactor: number;
    readonly geocodeCacheSeconds: number;
  };
}
