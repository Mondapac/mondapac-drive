import {
  addMoney,
  money,
  scaleMoney,
  subtractMoney,
  type Money,
} from '@mondapac-drive/shared-kernel';
import { DeliveryDomainError } from './errors';
import type { MarketDeliverySettings, VehicleRate } from './market-settings';
import type { Parcel } from './parcel';
import type { DeliveryMode } from './schedule';
import { VEHICLE_TYPES, type VehicleType } from './vehicle';

export interface PriceBreakdown {
  readonly base: Money;
  readonly distance: Money;
  readonly coldChain: Money;
  /** Zero or negative. */
  readonly scheduledDiscount: Money;
}

/** The fee the merchant pays for one delivery, fixed before booking. */
export interface DeliveryQuote {
  readonly vehicle: VehicleType;
  readonly distanceMetres: number;
  readonly breakdown: PriceBreakdown;
  /** What the merchant pays, tax included. */
  readonly total: Money;
  /** The tax inside `total`. */
  readonly tax: Money;
}

export interface QuoteRequest {
  readonly parcel: Parcel;
  readonly distanceMetres: number;
  readonly mode: DeliveryMode;
  /** Ask for a specific vehicle; otherwise the cheapest one that can carry the parcel. */
  readonly vehicle?: VehicleType;
}

const BASIS_POINTS = 10_000n;

export function priceDelivery(
  settings: MarketDeliverySettings,
  request: QuoteRequest,
): DeliveryQuote {
  const candidates = VEHICLE_TYPES.filter(
    (type) => request.vehicle === undefined || type === request.vehicle,
  )
    .flatMap((type) => {
      const rate = settings.rateCard.vehicles[type];
      return rate && canCarry(rate, request) ? [quoteFor(settings, type, rate, request)] : [];
    })
    .sort((a, b) =>
      a.total.amount < b.total.amount ? -1 : a.total.amount > b.total.amount ? 1 : 0,
    );

  const cheapest = candidates[0];
  if (!cheapest) {
    throw new DeliveryDomainError(
      'quote.no-vehicle',
      request.vehicle
        ? `A ${request.vehicle} cannot carry this parcel over this distance`
        : 'No vehicle in this Market can carry this parcel over this distance',
    );
  }
  return cheapest;
}

function canCarry(rate: VehicleRate, request: QuoteRequest): boolean {
  return (
    request.distanceMetres <= rate.maxDistanceMetres &&
    request.parcel.weightGrams <= rate.maxWeightGrams &&
    request.parcel.volumeLitres <= rate.maxVolumeLitres &&
    rate.temperatures.includes(request.parcel.temperature)
  );
}

function quoteFor(
  settings: MarketDeliverySettings,
  vehicle: VehicleType,
  rate: VehicleRate,
  request: QuoteRequest,
): DeliveryQuote {
  const currency = settings.currency;
  const minor = (amount: number) => money(BigInt(amount), currency);
  const base = minor(rate.baseFee);
  // Rounded half-up, as every rate in the kernel (marketplace ADR-0007 decision 2).
  const distance = scaleMoney(minor(rate.perKm), BigInt(request.distanceMetres), 1000n);
  const coldChain = minor(settings.rateCard.coldChainSurcharge[request.parcel.temperature]);
  const beforeDiscount = addMoney(addMoney(base, distance), coldChain);
  const discount =
    request.mode === 'scheduled'
      ? scaleMoney(beforeDiscount, BigInt(settings.rateCard.scheduledDiscountBps), BASIS_POINTS)
      : minor(0);
  const price = subtractMoney(beforeDiscount, discount);

  // A rate card states prices the way the Market quotes them: tax-inclusive or not.
  const rateBps = BigInt(settings.taxRateBps);
  const tax = settings.pricesIncludeTax
    ? scaleMoney(price, rateBps, BASIS_POINTS + rateBps)
    : scaleMoney(price, rateBps, BASIS_POINTS);
  const total = settings.pricesIncludeTax ? price : addMoney(price, tax);

  return {
    vehicle,
    distanceMetres: request.distanceMetres,
    breakdown: { base, distance, coldChain, scheduledDiscount: subtractMoney(minor(0), discount) },
    total,
    tax,
  };
}
