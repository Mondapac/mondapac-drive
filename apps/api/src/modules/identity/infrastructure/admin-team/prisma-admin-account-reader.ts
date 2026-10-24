import type { FactoryProvider } from '@nestjs/common';
import type { Id, MarketContext } from '@mondapac-drive/shared-kernel';
import { PrismaService } from '../../../../platform/persistence/prisma.service';
import {
  ADMIN_ACCOUNT_READER,
  type AdminAccountReader,
  type AdminAccountSummary,
} from '../../application/ports/admin-account-reader';

/**
 * {@link AdminAccountReader} on `identity.accounts` (data design 3.3; slice 8c): one statement
 * through `PrismaService.tx(market)` with `marketId` at the top level of `where` (P 4). It reads
 * the id, the address, the name and the status: never the credential. The `(market_id,
 * population, email_normalized)` unique index serves the Market and population prefix and a
 * Market holds 10² admin rows or fewer, so, as for the reviewer read, no index of its own. The
 * courier list reads the `courier` population the same way.
 */
export class PrismaAdminAccountReader implements AdminAccountReader {
  constructor(private readonly prisma: PrismaService) {}

  adminAccounts(
    market: MarketContext,
    after: Id<'Account'> | null,
    limit: number,
  ): Promise<AdminAccountSummary[]> {
    return this.accountsOf(market, 'admin', after, limit);
  }

  courierAccounts(
    market: MarketContext,
    after: Id<'Account'> | null,
    limit: number,
  ): Promise<AdminAccountSummary[]> {
    return this.accountsOf(market, 'courier', after, limit);
  }

  private async accountsOf(
    market: MarketContext,
    population: 'admin' | 'courier',
    after: Id<'Account'> | null,
    limit: number,
  ): Promise<AdminAccountSummary[]> {
    const rows = await this.prisma.tx(market).identityAccount.findMany({
      where: {
        marketId: market.marketId,
        population,
        ...(after === null ? {} : { id: { gt: after } }),
      },
      select: { id: true, email: true, displayName: true, status: true },
      orderBy: { id: 'asc' },
      take: limit,
    });
    return rows.map((row) => ({
      accountId: row.id as Id<'Account'>,
      email: row.email,
      displayName: row.displayName,
      // The `accounts_status_check` CHECK holds the two values.
      status: row.status === 'disabled' ? 'disabled' : 'active',
    }));
  }
}

/** Binds {@link ADMIN_ACCOUNT_READER} (only `infrastructure/` may reach `PrismaService`). */
export const adminAccountReaderProvider: FactoryProvider<AdminAccountReader> = {
  provide: ADMIN_ACCOUNT_READER,
  inject: [PrismaService],
  useFactory: (prisma: PrismaService) => new PrismaAdminAccountReader(prisma),
};
