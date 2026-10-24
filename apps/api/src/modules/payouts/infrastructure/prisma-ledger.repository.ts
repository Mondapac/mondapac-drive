import {
  addMoney,
  money,
  Temporal,
  type Money,
  type Id,
  type MarketContext,
} from '@mondapac-drive/shared-kernel';
import type { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { CourierDeliveryRecord, LedgerRepository } from '../application/ports';
import type {
  AdjustmentReason,
  Balance,
  LedgerEntry,
  LedgerEntryKind,
  ReversalReason,
} from '../domain/ledger';
import type { CourierBalance } from '../domain/payout-run';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

interface EntryRow {
  readonly id: string;
  readonly courierId: string;
  readonly kind: string;
  readonly amount: bigint;
  readonly taxAmount: bigint;
  readonly currency: string;
  readonly reference: string;
  readonly deliveryId: string | null;
  readonly payoutLineId: string | null;
  readonly reversesEntryId: string | null;
  readonly reason: string | null;
  readonly occurredAt: Date;
  readonly recordedAt: Date;
}

const SELECT_ENTRY = {
  id: true,
  courierId: true,
  kind: true,
  amount: true,
  taxAmount: true,
  currency: true,
  reference: true,
  deliveryId: true,
  payoutLineId: true,
  reversesEntryId: true,
  reason: true,
  occurredAt: true,
  recordedAt: true,
} as const;

function readEntry(row: EntryRow): LedgerEntry {
  return Object.freeze({
    id: row.id as Id<'LedgerEntry'>,
    courierId: row.courierId,
    kind: row.kind as LedgerEntryKind,
    amount: money(row.amount, row.currency),
    tax: money(row.taxAmount, row.currency),
    reference: row.reference,
    ...(row.deliveryId === null ? {} : { deliveryId: row.deliveryId }),
    ...(row.payoutLineId === null ? {} : { payoutLineId: row.payoutLineId }),
    ...(row.reversesEntryId === null
      ? {}
      : { reversesEntryId: row.reversesEntryId as Id<'LedgerEntry'> }),
    ...(row.reason === null ? {} : { reason: row.reason as AdjustmentReason | ReversalReason }),
    occurredAt: toInstant(row.occurredAt),
    recordedAt: toInstant(row.recordedAt),
  });
}

function balanceFrom(amount: bigint | null, tax: bigint | null, currency: string): Balance {
  const net = money(amount ?? 0n, currency);
  const taxed = money(tax ?? 0n, currency);
  return { amount: net, tax: taxed, total: addMoney(net, taxed) };
}

/**
 * {@link LedgerRepository} on `payouts.ledger_entries` and `payouts.courier_deliveries`, through
 * the open unit's guarded client: every `where` and every row pins the unit's Market and tenant.
 * It only reads and inserts; the database grants the application nothing else on these tables.
 */
export class PrismaLedgerRepository implements LedgerRepository {
  constructor(private readonly prisma: PrismaService) {}

  async append(market: MarketContext, entries: readonly LedgerEntry[]): Promise<number> {
    if (entries.length === 0) return 0;
    const created = await this.prisma.tx(market).payoutsLedgerEntry.createMany({
      data: entries.map((entry) => ({
        marketId: market.marketId,
        tenantId: market.tenantId,
        id: entry.id,
        courierId: entry.courierId,
        kind: entry.kind,
        amount: entry.amount.amount,
        taxAmount: entry.tax.amount,
        currency: entry.amount.currency,
        reference: entry.reference,
        deliveryId: entry.deliveryId ?? null,
        payoutLineId: entry.payoutLineId ?? null,
        reversesEntryId: entry.reversesEntryId ?? null,
        reason: entry.reason ?? null,
        occurredAt: toDate(entry.occurredAt),
        recordedAt: toDate(entry.recordedAt),
      })),
      skipDuplicates: true,
    });
    return created.count;
  }

  async findByReference(market: MarketContext, reference: string) {
    const row = await this.prisma.tx(market).payoutsLedgerEntry.findFirst({
      where: { marketId: market.marketId, tenantId: market.tenantId, reference },
      select: SELECT_ENTRY,
    });
    return row === null ? undefined : readEntry(row);
  }

  async entriesOfDelivery(market: MarketContext, deliveryId: string) {
    const rows = await this.prisma.tx(market).payoutsLedgerEntry.findMany({
      where: { marketId: market.marketId, tenantId: market.tenantId, deliveryId },
      orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
      select: SELECT_ENTRY,
    });
    return rows.map(readEntry);
  }

  async recentEntries(market: MarketContext, courierId: string, limit: number) {
    const rows = await this.prisma.tx(market).payoutsLedgerEntry.findMany({
      where: { marketId: market.marketId, tenantId: market.tenantId, courierId },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: SELECT_ENTRY,
    });
    return rows.map(readEntry);
  }

  async balanceOf(market: MarketContext, courierId: string, currency: string): Promise<Balance> {
    const sums = await this.prisma.tx(market).payoutsLedgerEntry.aggregate({
      where: { marketId: market.marketId, tenantId: market.tenantId, courierId, currency },
      _sum: { amount: true, taxAmount: true },
    });
    return balanceFrom(sums._sum.amount, sums._sum.taxAmount, currency);
  }

  async balancesBefore(
    market: MarketContext,
    cutoff: Temporal.Instant,
    currency: string,
  ): Promise<CourierBalance[]> {
    const groups = await this.prisma.tx(market).payoutsLedgerEntry.groupBy({
      by: ['courierId'],
      where: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        currency,
        occurredAt: { lt: toDate(cutoff) },
      },
      _sum: { amount: true, taxAmount: true },
      orderBy: { courierId: 'asc' },
    });
    return groups.map((group) => ({
      courierId: group.courierId,
      balance: balanceFrom(group._sum.amount, group._sum.taxAmount, currency),
    }));
  }

  async recordDelivery(market: MarketContext, record: CourierDeliveryRecord): Promise<boolean> {
    const { delivery, earning } = record;
    const text = (value: { readonly amount: bigint }) => value.amount.toString();
    const created = await this.prisma.tx(market).payoutsCourierDelivery.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          deliveryId: delivery.deliveryId,
          courierId: delivery.courierId,
          engagement: record.engagement,
          vehicle: delivery.vehicle,
          temperature: delivery.temperature,
          distanceMetres: delivery.distanceMetres,
          paidWaitingMinutes: earning.paidWaitingMinutes,
          breakdown: {
            base: text(earning.base),
            distance: text(earning.distance),
            coldChain: text(earning.coldChain),
            waiting: text(earning.waiting),
          } satisfies Prisma.InputJsonObject,
          earningAmount: earning.total.amount,
          currency: earning.total.currency,
          deliveredAt: toDate(delivery.deliveredAt),
          recordedAt: toDate(record.recordedAt),
        },
      ],
      skipDuplicates: true,
    });
    return created.count === 1;
  }

  async earnedSince(
    market: MarketContext,
    courierId: string,
    since: Temporal.Instant,
    currency: string,
  ): Promise<Money> {
    const sums = await this.prisma.tx(market).payoutsLedgerEntry.aggregate({
      where: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        courierId,
        currency,
        kind: { not: 'payout' },
        occurredAt: { gte: toDate(since) },
      },
      _sum: { amount: true, taxAmount: true },
    });
    return balanceFrom(sums._sum.amount, sums._sum.taxAmount, currency).total;
  }

  async deliveriesSince(
    market: MarketContext,
    courierId: string,
    since: Temporal.Instant,
  ): Promise<number> {
    return this.prisma.tx(market).payoutsCourierDelivery.count({
      where: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        courierId,
        deliveredAt: { gte: toDate(since) },
      },
    });
  }
}
