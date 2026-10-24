import { addMoney, money, scaleMoney, Temporal, type Money } from '@mondapac-drive/shared-kernel';
import { PayoutsDomainError } from './errors';
import type { Engagement } from './payee';
import type { MarketPayoutSettings, Temperature, VehicleType } from './payout-settings';

/** A delivery a courier completed, as the delivery module reports it. */
export interface CompletedDelivery {
  readonly deliveryId: string;
  readonly courierId: string;
  readonly vehicle: VehicleType;
  readonly distanceMetres: number;
  readonly temperature: Temperature;
  readonly arrivedAtPickup?: Temporal.Instant;
  readonly pickedUpAt?: Temporal.Instant;
  readonly arrivedAtDropoff?: Temporal.Instant;
  readonly deliveredAt: Temporal.Instant;
}

/** What one delivery earns, part by part, before tax. */
export interface EarningBreakdown {
  readonly base: Money;
  readonly distance: Money;
  readonly coldChain: Money;
  readonly waiting: Money;
  /** The waiting minutes paid, after the free minutes and the cap. */
  readonly paidWaitingMinutes: number;
  readonly total: Money;
}

/**
 * The paid waiting minutes of a delivery: at each stop, the whole minutes between arriving and
 * leaving beyond the free minutes, both stops together capped at `maxPaidMinutes`. A stop whose
 * arrival or departure is unknown counts nothing.
 */
export function paidWaitingMinutes(
  settings: MarketPayoutSettings,
  delivery: CompletedDelivery,
): number {
  const { freeMinutes, maxPaidMinutes } = settings.earnings.waiting;
  const atStop = (arrived?: Temporal.Instant, left?: Temporal.Instant): number => {
    if (arrived === undefined || left === undefined) return 0;
    if (Temporal.Instant.compare(left, arrived) < 0) {
      throw new PayoutsDomainError(
        'earnings.invalid-timeline',
        'A courier cannot leave a stop before arriving at it',
      );
    }
    const minutes = Math.floor(arrived.until(left).total({ unit: 'minutes' }));
    return Math.max(0, minutes - freeMinutes);
  };
  const waited =
    atStop(delivery.arrivedAtPickup, delivery.pickedUpAt) +
    atStop(delivery.arrivedAtDropoff, delivery.deliveredAt);
  return Math.min(waited, maxPaidMinutes);
}

/**
 * What a courier earns for a completed delivery, from the Market's rates: a base per delivery and
 * a rate per kilometre for the vehicle, a cold-chain bonus for chilled or frozen parcels, and
 * paid waiting time. An employee earns nothing per delivery (paid through payroll), so every
 * part is zero. Amounts are minor units of the Market's settlement currency, rounded half-up.
 */
export function earningFor(
  settings: MarketPayoutSettings,
  engagement: Engagement,
  delivery: CompletedDelivery,
): EarningBreakdown {
  if (!Number.isSafeInteger(delivery.distanceMetres) || delivery.distanceMetres < 0) {
    throw new PayoutsDomainError(
      'earnings.invalid-distance',
      'The distance must be a whole number of metres',
    );
  }
  const minor = (amount: number) => money(BigInt(amount), settings.currency);
  const minutes = paidWaitingMinutes(settings, delivery);
  if (engagement === 'employee') {
    const zero = minor(0);
    return {
      base: zero,
      distance: zero,
      coldChain: zero,
      waiting: zero,
      paidWaitingMinutes: minutes,
      total: zero,
    };
  }

  const rate = settings.earnings.vehicles[delivery.vehicle];
  if (rate === undefined) {
    throw new PayoutsDomainError(
      'earnings.vehicle-not-rated',
      `This Market has no courier rate for a ${delivery.vehicle}`,
    );
  }
  const base = minor(rate.perDelivery);
  const distance = scaleMoney(minor(rate.perKm), BigInt(delivery.distanceMetres), 1000n);
  const coldChain = minor(settings.earnings.coldChainBonus[delivery.temperature]);
  const waiting = minor(settings.earnings.waiting.perMinute * minutes);
  return {
    base,
    distance,
    coldChain,
    waiting,
    paidWaitingMinutes: minutes,
    total: addMoney(addMoney(addMoney(base, distance), coldChain), waiting),
  };
}
