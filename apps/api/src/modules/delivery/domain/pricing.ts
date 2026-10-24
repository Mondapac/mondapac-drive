import { addMoney, money, scaleMoney, type Money } from '@mondapac-drive/shared-kernel';
import { DeliveryDomainError } from './errors.js';
import type { MarketDeliverySettings, VehicleRate } from './market-settings.js';
import type { Parcel } from './parcel.js';
import type { DeliveryMode } from './schedule.js';
import { VEHICLE_TYPES, type VehicleType } from './vehicle.js';

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
    .sort((a, b) => a.total.amount - b.total.amount);

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
  const base = money(rate.baseFee, currency);
  const distance = money(Math.round((rate.perKm * request.distanceMetres) / 1000), currency);
  const coldChain = money(
    settings.rateCard.coldChainSurcharge[request.parcel.temperature],
    currency,
  );
  const beforeDiscount = addMoney(addMoney(base, distance), coldChain);
  const scheduledDiscount =
    request.mode === 'scheduled'
      ? scaleMoney(beforeDiscount, -settings.rateCard.scheduledDiscountBps)
      : money(0, currency);
  const price = addMoney(beforeDiscount, scheduledDiscount);

  // A rate card states prices the way the Market quotes them: tax-inclusive or not.
  const rateBps = settings.taxRateBps;
  const tax = settings.pricesIncludeTax
    ? money(Math.round((price.amount * rateBps) / (10_000 + rateBps)), currency)
    : scaleMoney(price, rateBps);
  const total = settings.pricesIncludeTax ? price : addMoney(price, tax);

  return {
    vehicle,
    distanceMetres: request.distanceMetres,
    breakdown: { base, distance, coldChain, scheduledDiscount },
    total,
    tax,
  };
}
