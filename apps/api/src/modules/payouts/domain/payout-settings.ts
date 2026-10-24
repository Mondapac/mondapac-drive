import type { MarketId } from '@mondapac-drive/shared-kernel';

/**
 * Vehicle types and parcel temperatures as the delivery module names them. Payouts keeps its own
 * copy of the two lists: it reads delivery facts by value and never imports delivery's internals.
 */
export const VEHICLE_TYPES = ['bicycle', 'motorbike', 'car', 'van'] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];
export const TEMPERATURES = ['ambient', 'chilled', 'frozen'] as const;
export type Temperature = (typeof TEMPERATURES)[number];

/** What a contractor earns for one delivery by one vehicle, in minor units. */
export interface VehicleEarningRate {
  readonly perDelivery: number;
  readonly perKm: number;
}

/** When a payout run closes: every week on an ISO weekday (1 is Monday), or every day. */
export interface PayoutSchedule {
  readonly cadence: 'weekly' | 'daily';
  /** ISO weekday 1 to 7; ignored for a daily cadence. */
  readonly weekday: number;
  /** Local wall time of the cutoff, "HH:MM", in the Market's time zone. */
  readonly time: string;
}

/**
 * Everything about courier pay that differs by Market: the `payouts` section of
 * `config/markets/<CODE>.json` and the Market's settlement currency and time zone. Money values
 * are minor units of `currency`.
 */
export interface MarketPayoutSettings {
  readonly marketId: MarketId;
  readonly currency: string;
  readonly timezone: string;
  readonly earnings: {
    readonly vehicles: Partial<Record<VehicleType, VehicleEarningRate>>;
    readonly coldChainBonus: Readonly<Record<Temperature, number>>;
    readonly waiting: {
      /** Minutes at each stop that are not paid. */
      readonly freeMinutes: number;
      readonly perMinute: number;
      /** The most waiting minutes paid for one delivery, both stops together. */
      readonly maxPaidMinutes: number;
    };
  };
  readonly schedule: PayoutSchedule;
  /** A balance below this waits for a later run. */
  readonly minimumPayout: number;
  readonly tax: {
    /**
     * The indirect tax (AU: GST) added to a contractor's pay when the contractor is registered
     * for it; nothing is added for one who is not.
     */
    readonly rateBps: number;
    /** Whether tips carry that tax too. */
    readonly onTips: boolean;
    /** A contractor is paid only with a verified business id (AU: ABN). */
    readonly businessIdRequired: boolean;
  };
  readonly provider: {
    /** ISO 3166 country of the couriers' connected accounts. */
    readonly accountCountry: string;
    readonly onboardingReturnUrl: string;
    readonly onboardingRefreshUrl: string;
  };
}
