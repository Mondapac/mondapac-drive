import { Temporal } from '@mondapac-drive/shared-kernel';
import type { Id, MarketContext } from '@mondapac-drive/shared-kernel';
import type { PrismaService } from '../../../../platform/persistence/prisma.service';
import type {
  SignInRecord,
  SignInRecordRepository,
} from '../../application/ports/sign-in-record.repository';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

/**
 * {@link SignInRecordRepository} on `identity.sign_in_records` (data design 3.6): insert, read
 * the oldest instant, delete by a range of `occurred_at` on `(market_id, occurred_at)`. The
 * application has no `UPDATE` on the table.
 */
export class PrismaSignInRecordRepository implements SignInRecordRepository {
  constructor(private readonly prisma: PrismaService) {}

  async add(market: MarketContext, record: SignInRecord): Promise<void> {
    await this.prisma.tx(market).identitySignInRecord.create({
      data: {
        id: record.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        population: record.population,
        accountId: record.accountId,
        outcome: record.outcome,
        occurredAt: toDate(record.occurredAt),
        origin: record.address,
        sessionId: record.sessionId,
        correlationId: record.correlationId,
      },
      select: { id: true },
    });
  }

  async latestSuccessBefore(
    market: MarketContext,
    accountId: Id<'Account'>,
    exceptSession: Id<'Session'>,
  ): Promise<Temporal.Instant | null> {
    const row = await this.prisma.tx(market).identitySignInRecord.findFirst({
      where: {
        marketId: market.marketId,
        accountId,
        outcome: 'signed-in',
        sessionId: { not: exceptSession },
      },
      orderBy: { occurredAt: 'desc' },
      select: { occurredAt: true },
    });
    return row === null ? null : Temporal.Instant.fromEpochMilliseconds(row.occurredAt.getTime());
  }

  async oldest(market: MarketContext): Promise<Temporal.Instant | null> {
    const row = await this.prisma.tx(market).identitySignInRecord.findFirst({
      where: { marketId: market.marketId },
      orderBy: { occurredAt: 'asc' },
      select: { occurredAt: true },
    });
    return row === null ? null : Temporal.Instant.fromEpochMilliseconds(row.occurredAt.getTime());
  }

  async deleteBetween(
    market: MarketContext,
    from: Temporal.Instant,
    to: Temporal.Instant,
  ): Promise<number> {
    const { count } = await this.prisma.tx(market).identitySignInRecord.deleteMany({
      where: {
        marketId: market.marketId,
        occurredAt: { gte: toDate(from), lt: toDate(to) },
      },
    });
    return count;
  }
}
