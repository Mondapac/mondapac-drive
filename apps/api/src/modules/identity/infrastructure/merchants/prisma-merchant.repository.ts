import { parseMarketId, Temporal } from '@mondapac-drive/shared-kernel';
import type { Id, MarketContext, MarketId } from '@mondapac-drive/shared-kernel';
import type { PrismaService } from '../../../../platform/persistence/prisma.service';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type {
  MerchantMembershipRepository,
  MerchantRepository,
} from '../../application/ports/merchant.repository';
import {
  Merchant,
  type MerchantMembership,
  type MerchantMembershipStateCode,
  type MerchantStateCode,
} from '../../domain/merchant';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

function marketOf(table: string, value: string): MarketId {
  const parsed = parseMarketId(value);
  if (!parsed.ok) throw new Error(`identity.${table}: a stored row is malformed`);
  return parsed.value;
}

const MERCHANT = {
  id: true,
  marketId: true,
  name: true,
  state: true,
  stateChangedAt: true,
  version: true,
  createdAt: true,
} as const;

function restoreMerchant(row: {
  id: string;
  marketId: string;
  name: string;
  state: string;
  stateChangedAt: Date;
  version: number;
  createdAt: Date;
}): Merchant {
  return Merchant.restore({
    id: row.id as Id<'Merchant'>,
    marketId: marketOf('merchants', row.marketId),
    name: row.name,
    state: row.state as MerchantStateCode,
    stateChangedAt: toInstant(row.stateChangedAt),
    version: row.version,
    createdAt: toInstant(row.createdAt),
  });
}

/**
 * {@link MerchantRepository} on `identity.merchants`: every statement with `marketId` at the top
 * level of `where`, single-table writes.
 */
export class PrismaMerchantRepository implements MerchantRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(market: MarketContext, id: Id<'Merchant'>): Promise<Merchant | null> {
    const row = await this.prisma.tx(market).identityMerchant.findFirst({
      where: { marketId: market.marketId, id },
      select: MERCHANT,
    });
    return row === null ? null : restoreMerchant(row);
  }

  async list(market: MarketContext): Promise<Merchant[]> {
    const rows = await this.prisma.tx(market).identityMerchant.findMany({
      where: { marketId: market.marketId },
      select: MERCHANT,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return rows.map(restoreMerchant);
  }

  async add(market: MarketContext, merchant: Merchant): Promise<void> {
    const state = merchant.state;
    await this.prisma.tx(market).identityMerchant.create({
      data: {
        id: state.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        name: state.name,
        state: state.state,
        stateChangedAt: toDate(state.stateChangedAt),
        version: state.version,
        createdAt: toDate(state.createdAt),
      },
      select: { id: true },
    });
  }

  async save(market: MarketContext, merchant: Merchant): Promise<void> {
    const state = merchant.state;
    const expected = merchant.persistedVersion;
    if (expected === null) throw new Error('save: the merchant was never stored; use add');
    if (state.version === expected) return;
    const { count } = await this.prisma.tx(market).identityMerchant.updateMany({
      where: { marketId: market.marketId, id: state.id, version: expected },
      data: {
        state: state.state,
        stateChangedAt: toDate(state.stateChangedAt),
        version: state.version,
      },
    });
    if (count !== 1) throw new StaleAggregateError('merchant', state.id);
  }
}

const MEMBERSHIP = {
  id: true,
  marketId: true,
  accountId: true,
  merchantId: true,
  state: true,
  removedAt: true,
  version: true,
  createdAt: true,
} as const;

/** {@link MerchantMembershipRepository} on `identity.merchant_memberships`. */
export class PrismaMerchantMembershipRepository implements MerchantMembershipRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findActiveByAccount(
    market: MarketContext,
    accountId: Id<'Account'>,
  ): Promise<MerchantMembership | null> {
    const row = await this.prisma.tx(market).identityMerchantMembership.findFirst({
      where: { marketId: market.marketId, accountId, state: 'active' },
      select: MEMBERSHIP,
    });
    if (row === null) return null;
    return Object.freeze({
      id: row.id as Id<'MerchantMembership'>,
      marketId: marketOf('merchant_memberships', row.marketId),
      accountId: row.accountId as Id<'Account'>,
      merchantId: row.merchantId as Id<'Merchant'>,
      state: row.state as MerchantMembershipStateCode,
      removedAt: row.removedAt === null ? null : toInstant(row.removedAt),
      version: row.version,
      createdAt: toInstant(row.createdAt),
    });
  }

  async activeMembersOf(
    market: MarketContext,
    merchantId: Id<'Merchant'>,
  ): Promise<Id<'Account'>[]> {
    // On the index (market_id, merchant_id, state).
    const rows = await this.prisma.tx(market).identityMerchantMembership.findMany({
      where: { marketId: market.marketId, merchantId, state: 'active' },
      select: { accountId: true },
      orderBy: { accountId: 'asc' },
    });
    return rows.map((row) => row.accountId as Id<'Account'>);
  }

  async add(market: MarketContext, membership: MerchantMembership): Promise<void> {
    await this.prisma.tx(market).identityMerchantMembership.create({
      data: {
        id: membership.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        accountId: membership.accountId,
        merchantId: membership.merchantId,
        state: membership.state,
        removedAt: membership.removedAt === null ? null : toDate(membership.removedAt),
        version: membership.version,
        createdAt: toDate(membership.createdAt),
      },
      select: { id: true },
    });
  }
}
