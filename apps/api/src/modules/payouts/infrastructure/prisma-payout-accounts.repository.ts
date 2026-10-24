import { Temporal, type MarketContext } from '@mondapac-drive/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { PayoutAccountRepository } from '../application/ports';
import type { PayoutAccount } from '../domain/payout-run';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

interface AccountRow {
  readonly courierId: string;
  readonly providerAccountId: string;
  readonly payoutsEnabled: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const SELECT_ACCOUNT = {
  courierId: true,
  providerAccountId: true,
  payoutsEnabled: true,
  createdAt: true,
  updatedAt: true,
} as const;

function readAccount(row: AccountRow): PayoutAccount {
  return Object.freeze({
    courierId: row.courierId,
    providerAccountId: row.providerAccountId,
    payoutsEnabled: row.payoutsEnabled,
    createdAt: toInstant(row.createdAt),
    updatedAt: toInstant(row.updatedAt),
  });
}

/**
 * {@link PayoutAccountRepository} on `payouts.payout_accounts` and `payouts.provider_events`,
 * through the open unit's guarded client. Only the provider's account id is stored.
 */
export class PrismaPayoutAccountRepository implements PayoutAccountRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(market: MarketContext, courierId: string) {
    const row = await this.prisma.tx(market).payoutsAccount.findFirst({
      where: { marketId: market.marketId, tenantId: market.tenantId, courierId },
      select: SELECT_ACCOUNT,
    });
    return row === null ? undefined : readAccount(row);
  }

  async findMany(market: MarketContext, courierIds: readonly string[]) {
    if (courierIds.length === 0) return [];
    const rows = await this.prisma.tx(market).payoutsAccount.findMany({
      where: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        courierId: { in: [...courierIds] },
      },
      select: SELECT_ACCOUNT,
    });
    return rows.map(readAccount);
  }

  async findByProviderAccount(market: MarketContext, providerAccountId: string) {
    const row = await this.prisma.tx(market).payoutsAccount.findFirst({
      where: { marketId: market.marketId, tenantId: market.tenantId, providerAccountId },
      select: SELECT_ACCOUNT,
    });
    return row === null ? undefined : readAccount(row);
  }

  async insert(market: MarketContext, account: PayoutAccount): Promise<boolean> {
    const created = await this.prisma.tx(market).payoutsAccount.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          courierId: account.courierId,
          providerAccountId: account.providerAccountId,
          payoutsEnabled: account.payoutsEnabled,
          createdAt: toDate(account.createdAt),
          updatedAt: toDate(account.updatedAt),
        },
      ],
      skipDuplicates: true,
    });
    return created.count === 1;
  }

  async update(market: MarketContext, account: PayoutAccount): Promise<void> {
    await this.prisma.tx(market).payoutsAccount.updateMany({
      where: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        courierId: account.courierId,
      },
      data: { payoutsEnabled: account.payoutsEnabled, updatedAt: toDate(account.updatedAt) },
    });
  }

  async recordProviderEvent(
    market: MarketContext,
    eventId: string,
    type: string,
    receivedAt: Temporal.Instant,
  ): Promise<boolean> {
    const created = await this.prisma.tx(market).payoutsProviderEvent.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          eventId,
          type,
          receivedAt: toDate(receivedAt),
        },
      ],
      skipDuplicates: true,
    });
    return created.count === 1;
  }
}
