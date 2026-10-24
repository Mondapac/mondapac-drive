import {
  geoPoint,
  money,
  Temporal,
  type Id,
  type MarketContext,
  type Money,
} from '@mondapac-drive/shared-kernel';
import type { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import type { DeliveryRepository } from '../application/ports';
import type {
  DeliveryHistoryEntry,
  DeliveryState,
  ProofOfDelivery,
  Stop,
} from '../domain/delivery';
import type { DeliveryEventType, DeliveryStatus } from '../domain/delivery-status';
import type { Temperature } from '../domain/parcel';
import type { DeliveryQuote } from '../domain/pricing';
import type { DeliveryMode } from '../domain/schedule';
import type { VehicleType } from '../domain/vehicle';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

/** A stop as stored in the `pickup` and `dropoff` JSON columns; the point has its own columns. */
interface StoredStop {
  readonly address: string;
  readonly postcode: string;
  readonly contactName: string;
  readonly contactPhone: string;
  readonly notes?: string;
}

/** Money in JSON: the amount as decimal text, since JSON has no 64-bit integer. */
interface StoredMoney {
  readonly amount: string;
  readonly currency: string;
}

interface StoredQuote {
  readonly vehicle: VehicleType;
  readonly distanceMetres: number;
  readonly breakdown: Record<keyof DeliveryQuote['breakdown'], StoredMoney>;
  readonly total: StoredMoney;
  readonly tax: StoredMoney;
}

const storedMoney = (value: Money): StoredMoney => ({
  amount: value.amount.toString(),
  currency: value.currency,
});
const readMoney = (value: StoredMoney): Money => money(BigInt(value.amount), value.currency);

function storedStop(stop: Stop): StoredStop {
  return {
    address: stop.address,
    postcode: stop.postcode,
    contactName: stop.contactName,
    contactPhone: stop.contactPhone,
    ...(stop.notes === undefined ? {} : { notes: stop.notes }),
  };
}

function storedQuote(quote: DeliveryQuote): StoredQuote {
  return {
    vehicle: quote.vehicle,
    distanceMetres: quote.distanceMetres,
    breakdown: {
      base: storedMoney(quote.breakdown.base),
      distance: storedMoney(quote.breakdown.distance),
      coldChain: storedMoney(quote.breakdown.coldChain),
      scheduledDiscount: storedMoney(quote.breakdown.scheduledDiscount),
    },
    total: storedMoney(quote.total),
    tax: storedMoney(quote.tax),
  };
}

function readQuote(stored: StoredQuote): DeliveryQuote {
  return {
    vehicle: stored.vehicle,
    distanceMetres: stored.distanceMetres,
    breakdown: {
      base: readMoney(stored.breakdown.base),
      distance: readMoney(stored.breakdown.distance),
      coldChain: readMoney(stored.breakdown.coldChain),
      scheduledDiscount: readMoney(stored.breakdown.scheduledDiscount),
    },
    total: readMoney(stored.total),
    tax: readMoney(stored.tax),
  };
}

interface DeliveryRow {
  readonly id: string;
  readonly marketId: string;
  readonly merchantId: string;
  readonly externalReference: string;
  readonly serviceAreaCode: string;
  readonly status: string;
  readonly mode: string;
  readonly windowStart: Date | null;
  readonly windowEnd: Date | null;
  readonly pickup: Prisma.JsonValue;
  readonly dropoff: Prisma.JsonValue;
  readonly pickupLat: number;
  readonly pickupLng: number;
  readonly dropoffLat: number;
  readonly dropoffLng: number;
  readonly weightGrams: number;
  readonly volumeLitres: number;
  readonly temperature: string;
  readonly quote: Prisma.JsonValue;
  readonly courierId: string | null;
  readonly createdAt: Date;
  readonly version: number;
}

interface EventRow {
  readonly type: string;
  readonly status: string;
  readonly courierId: string | null;
  readonly vehicle: string | null;
  readonly temperatureCelsius: Prisma.Decimal | null;
  readonly proof: Prisma.JsonValue;
  readonly reason: string | null;
  readonly at: Date;
}

const SELECT_DELIVERY = {
  id: true,
  marketId: true,
  merchantId: true,
  externalReference: true,
  serviceAreaCode: true,
  status: true,
  mode: true,
  windowStart: true,
  windowEnd: true,
  pickup: true,
  dropoff: true,
  pickupLat: true,
  pickupLng: true,
  dropoffLat: true,
  dropoffLng: true,
  weightGrams: true,
  volumeLitres: true,
  temperature: true,
  quote: true,
  courierId: true,
  createdAt: true,
  version: true,
} as const;

function readStop(stored: Prisma.JsonValue, lat: number, lng: number): Stop {
  const stop = stored as unknown as StoredStop;
  return { ...stop, point: geoPoint(lat, lng) };
}

function readEntry(row: EventRow): DeliveryHistoryEntry {
  return {
    type: row.type as DeliveryEventType,
    status: row.status as DeliveryStatus,
    at: toInstant(row.at),
    ...(row.courierId === null ? {} : { courierId: row.courierId }),
    ...(row.vehicle === null ? {} : { vehicle: row.vehicle as VehicleType }),
    ...(row.temperatureCelsius === null
      ? {}
      : { temperatureCelsius: row.temperatureCelsius.toNumber() }),
    ...(row.proof === null ? {} : { proof: row.proof as unknown as ProofOfDelivery }),
    ...(row.reason === null ? {} : { reason: row.reason }),
  };
}

function readDelivery(
  row: DeliveryRow,
  events: readonly EventRow[],
  market: MarketContext,
): DeliveryState {
  return {
    id: row.id as Id<'Delivery'>,
    marketId: market.marketId,
    merchantId: row.merchantId,
    externalReference: row.externalReference,
    serviceAreaCode: row.serviceAreaCode,
    pickup: readStop(row.pickup, row.pickupLat, row.pickupLng),
    dropoff: readStop(row.dropoff, row.dropoffLat, row.dropoffLng),
    parcel: {
      weightGrams: row.weightGrams,
      volumeLitres: row.volumeLitres,
      temperature: row.temperature as Temperature,
    },
    mode: row.mode as DeliveryMode,
    ...(row.windowStart !== null && row.windowEnd !== null
      ? { window: { start: toInstant(row.windowStart), end: toInstant(row.windowEnd) } }
      : {}),
    quote: readQuote(row.quote as unknown as StoredQuote),
    status: row.status as DeliveryStatus,
    ...(row.courierId === null ? {} : { courierId: row.courierId }),
    history: events.map(readEntry),
    createdAt: toInstant(row.createdAt),
    version: row.version,
  };
}

/**
 * {@link DeliveryRepository} on `delivery.deliveries` and `delivery.delivery_events`, through the
 * open unit's guarded client: every `where` and every row pins the unit's Market and tenant. A
 * delivery and its events are written by separate statements (the guard refuses nested writes).
 */
export class PrismaDeliveryRepository implements DeliveryRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(market: MarketContext, id: Id<'Delivery'>) {
    const row = await this.prisma.tx(market).deliveryDelivery.findFirst({
      where: { marketId: market.marketId, tenantId: market.tenantId, id },
      select: SELECT_DELIVERY,
    });
    return row === null ? undefined : this.withHistory(market, row);
  }

  async findByExternalReference(
    market: MarketContext,
    merchantId: string,
    externalReference: string,
  ) {
    const row = await this.prisma.tx(market).deliveryDelivery.findFirst({
      where: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        merchantId,
        externalReference,
      },
      select: SELECT_DELIVERY,
    });
    return row === null ? undefined : this.withHistory(market, row);
  }

  async insert(market: MarketContext, delivery: DeliveryState): Promise<boolean> {
    const tx = this.prisma.tx(market);
    const scope = { marketId: market.marketId, tenantId: market.tenantId };
    const created = await tx.deliveryDelivery.createMany({
      data: [
        {
          ...scope,
          id: delivery.id,
          merchantId: delivery.merchantId,
          externalReference: delivery.externalReference,
          serviceAreaCode: delivery.serviceAreaCode,
          status: delivery.status,
          mode: delivery.mode,
          windowStart: delivery.window ? toDate(delivery.window.start) : null,
          windowEnd: delivery.window ? toDate(delivery.window.end) : null,
          pickup: storedStop(delivery.pickup) as unknown as Prisma.InputJsonValue,
          dropoff: storedStop(delivery.dropoff) as unknown as Prisma.InputJsonValue,
          pickupLat: delivery.pickup.point.lat,
          pickupLng: delivery.pickup.point.lng,
          dropoffLat: delivery.dropoff.point.lat,
          dropoffLng: delivery.dropoff.point.lng,
          weightGrams: delivery.parcel.weightGrams,
          volumeLitres: delivery.parcel.volumeLitres,
          temperature: delivery.parcel.temperature,
          vehicle: delivery.quote.vehicle,
          distanceMetres: delivery.quote.distanceMetres,
          quote: storedQuote(delivery.quote) as unknown as Prisma.InputJsonValue,
          totalAmount: delivery.quote.total.amount,
          taxAmount: delivery.quote.tax.amount,
          currency: delivery.quote.total.currency,
          courierId: delivery.courierId ?? null,
          createdAt: toDate(delivery.createdAt),
          version: delivery.version,
        },
      ],
      skipDuplicates: true,
    });
    if (created.count === 0) return false;
    await this.appendHistory(market, delivery, 0);
    return true;
  }

  async update(market: MarketContext, delivery: DeliveryState): Promise<void> {
    const tx = this.prisma.tx(market);
    const updated = await tx.deliveryDelivery.updateMany({
      where: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        id: delivery.id,
        version: delivery.version - 1,
      },
      data: {
        status: delivery.status,
        courierId: delivery.courierId ?? null,
        version: delivery.version,
      },
    });
    if (updated.count !== 1) throw new StaleAggregateError('delivery', delivery.id);
    const stored = await tx.deliveryEvent.count({
      where: { marketId: market.marketId, tenantId: market.tenantId, deliveryId: delivery.id },
    });
    await this.appendHistory(market, delivery, stored);
  }

  private async appendHistory(
    market: MarketContext,
    delivery: DeliveryState,
    stored: number,
  ): Promise<void> {
    const entries = delivery.history.slice(stored);
    if (entries.length === 0) return;
    await this.prisma.tx(market).deliveryEvent.createMany({
      data: entries.map((entry, index) => ({
        marketId: market.marketId,
        tenantId: market.tenantId,
        deliveryId: delivery.id,
        sequence: stored + index + 1,
        type: entry.type,
        status: entry.status,
        courierId: entry.courierId ?? null,
        vehicle: entry.vehicle ?? null,
        temperatureCelsius: entry.temperatureCelsius ?? null,
        proof: entry.proof ?? undefined,
        reason: entry.reason ?? null,
        at: toDate(entry.at),
      })),
    });
  }

  private async withHistory(market: MarketContext, row: DeliveryRow): Promise<DeliveryState> {
    const events = await this.prisma.tx(market).deliveryEvent.findMany({
      where: { marketId: market.marketId, tenantId: market.tenantId, deliveryId: row.id },
      orderBy: { sequence: 'asc' },
      select: {
        type: true,
        status: true,
        courierId: true,
        vehicle: true,
        temperatureCelsius: true,
        proof: true,
        reason: true,
        at: true,
      },
    });
    return readDelivery(row, events, market);
  }
}
