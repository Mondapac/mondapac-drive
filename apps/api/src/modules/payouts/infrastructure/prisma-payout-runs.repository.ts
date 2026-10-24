import { money, Temporal, type Id, type MarketContext } from '@mondapac-drive/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import type { LineQuery, PayoutRunRepository } from '../application/ports';
import type { HoldReason, PayoutLine, PayoutLineStatus, PayoutRun } from '../domain/payout-run';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

interface LineRow {
  readonly id: string;
  readonly runId: string;
  readonly courierId: string;
  readonly amount: bigint;
  readonly taxAmount: bigint;
  readonly currency: string;
  readonly status: string;
  readonly holdReason: string | null;
  readonly destination: string | null;
  readonly transferId: string | null;
  readonly attempts: number;
  readonly lastErrorCode: string | null;
  readonly reversedAmount: bigint;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
}

const SELECT_LINE = {
  id: true,
  runId: true,
  courierId: true,
  amount: true,
  taxAmount: true,
  currency: true,
  status: true,
  holdReason: true,
  destination: true,
  transferId: true,
  attempts: true,
  lastErrorCode: true,
  reversedAmount: true,
  createdAt: true,
  updatedAt: true,
  version: true,
} as const;

function readLine(row: LineRow): PayoutLine {
  return Object.freeze({
    id: row.id as Id<'PayoutLine'>,
    runId: row.runId as Id<'PayoutRun'>,
    courierId: row.courierId,
    amount: money(row.amount, row.currency),
    tax: money(row.taxAmount, row.currency),
    status: row.status as PayoutLineStatus,
    ...(row.holdReason === null ? {} : { holdReason: row.holdReason as HoldReason }),
    ...(row.destination === null ? {} : { destination: row.destination }),
    ...(row.transferId === null ? {} : { transferId: row.transferId }),
    attempts: row.attempts,
    ...(row.lastErrorCode === null ? {} : { lastErrorCode: row.lastErrorCode }),
    reversedAmount: money(row.reversedAmount, row.currency),
    createdAt: toInstant(row.createdAt),
    updatedAt: toInstant(row.updatedAt),
    version: row.version,
  });
}

/**
 * {@link PayoutRunRepository} on `payouts.payout_runs` and `payouts.payout_lines`, through the
 * open unit's guarded client. A run and its lines are written by separate statements (the guard
 * refuses nested writes); a line changes only its transfer state (and, held at sending, its hold
 * reason), under the version check.
 */
export class PrismaPayoutRunRepository implements PayoutRunRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findRunByCutoff(market: MarketContext, cutoff: Temporal.Instant) {
    const row = await this.prisma.tx(market).payoutsRun.findFirst({
      where: { marketId: market.marketId, tenantId: market.tenantId, cutoff: toDate(cutoff) },
      select: { id: true, cutoff: true, currency: true, totalAmount: true, createdAt: true },
    });
    if (row === null) return undefined;
    return Object.freeze({
      id: row.id as Id<'PayoutRun'>,
      cutoff: toInstant(row.cutoff),
      currency: row.currency,
      total: money(row.totalAmount, row.currency),
      createdAt: toInstant(row.createdAt),
    }) satisfies PayoutRun;
  }

  async insertRun(
    market: MarketContext,
    run: PayoutRun,
    lines: readonly PayoutLine[],
  ): Promise<boolean> {
    const tx = this.prisma.tx(market);
    const scope = { marketId: market.marketId, tenantId: market.tenantId };
    const created = await tx.payoutsRun.createMany({
      data: [
        {
          ...scope,
          id: run.id,
          cutoff: toDate(run.cutoff),
          currency: run.currency,
          totalAmount: run.total.amount,
          createdAt: toDate(run.createdAt),
        },
      ],
      skipDuplicates: true,
    });
    if (created.count === 0) return false;
    if (lines.length > 0) {
      await tx.payoutsLine.createMany({
        data: lines.map((line) => ({
          ...scope,
          id: line.id,
          runId: run.id,
          courierId: line.courierId,
          amount: line.amount.amount,
          taxAmount: line.tax.amount,
          currency: line.amount.currency,
          status: line.status,
          holdReason: line.holdReason ?? null,
          destination: line.destination ?? null,
          transferId: line.transferId ?? null,
          attempts: line.attempts,
          lastErrorCode: line.lastErrorCode ?? null,
          reversedAmount: line.reversedAmount.amount,
          createdAt: toDate(line.createdAt),
          updatedAt: toDate(line.updatedAt),
          version: line.version,
        })),
      });
    }
    return true;
  }

  async pendingLines(market: MarketContext, limit: number) {
    const rows = await this.prisma.tx(market).payoutsLine.findMany({
      where: { marketId: market.marketId, tenantId: market.tenantId, status: 'pending' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: SELECT_LINE,
    });
    return rows.map(readLine);
  }

  async findLine(market: MarketContext, id: Id<'PayoutLine'>) {
    const row = await this.prisma.tx(market).payoutsLine.findFirst({
      where: { marketId: market.marketId, tenantId: market.tenantId, id },
      select: SELECT_LINE,
    });
    return row === null ? undefined : readLine(row);
  }

  async findLineByTransfer(market: MarketContext, transferId: string) {
    const row = await this.prisma.tx(market).payoutsLine.findFirst({
      where: { marketId: market.marketId, tenantId: market.tenantId, transferId },
      select: SELECT_LINE,
    });
    return row === null ? undefined : readLine(row);
  }

  async listLines(market: MarketContext, query: LineQuery) {
    const rows = await this.prisma.tx(market).payoutsLine.findMany({
      where: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        status: { in: [...query.statuses] },
        ...(query.courierId === undefined ? {} : { courierId: query.courierId }),
        ...(query.after === undefined ? {} : { id: { gt: query.after } }),
      },
      // Line ids are UUIDv7, so id order is creation order and a stable cursor.
      orderBy: { id: 'asc' },
      take: query.limit,
      select: SELECT_LINE,
    });
    return rows.map(readLine);
  }

  async updateLine(market: MarketContext, line: PayoutLine): Promise<void> {
    const updated = await this.prisma.tx(market).payoutsLine.updateMany({
      where: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        id: line.id,
        version: line.version - 1,
      },
      data: {
        status: line.status,
        holdReason: line.holdReason ?? null,
        transferId: line.transferId ?? null,
        attempts: line.attempts,
        lastErrorCode: line.lastErrorCode ?? null,
        reversedAmount: line.reversedAmount.amount,
        updatedAt: toDate(line.updatedAt),
        version: line.version,
      },
    });
    if (updated.count !== 1) throw new StaleAggregateError('payout-line', line.id);
  }
}
