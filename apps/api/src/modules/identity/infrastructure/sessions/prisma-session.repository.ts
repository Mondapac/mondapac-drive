import { parseMarketId, POPULATIONS, Temporal } from '@mondapac-drive/shared-kernel';
import type { Id, MarketContext, Population } from '@mondapac-drive/shared-kernel';
import type { PrismaService } from '../../../../platform/persistence/prisma.service';
import type {
  SessionForAuthentication,
  SessionRepository,
} from '../../application/ports/session.repository';
import { parseDeviceCode } from '../../domain/device';
import { MERCHANT_STATES, type MerchantStateCode } from '../../domain/merchant';
import type { Session, SessionRevokedReason } from '../../domain/session';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

const SELECTED = {
  id: true,
  marketId: true,
  accountId: true,
  population: true,
  merchantId: true,
  transport: true,
  device: true,
  label: true,
  createdAt: true,
  lastSeenAt: true,
  idleTimeoutSeconds: true,
  absoluteExpiresAt: true,
  revokedAt: true,
  revokedReason: true,
} as const;

interface SessionRow {
  readonly id: string;
  readonly marketId: string;
  readonly accountId: string;
  readonly population: string;
  readonly merchantId: string | null;
  readonly transport: string;
  readonly device: string | null;
  readonly label: string | null;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly idleTimeoutSeconds: number;
  readonly absoluteExpiresAt: Date;
  readonly revokedAt: Date | null;
  readonly revokedReason: string | null;
}

function restore(row: SessionRow): Session {
  const marketId = parseMarketId(row.marketId);
  if (
    !marketId.ok ||
    !(POPULATIONS as readonly string[]).includes(row.population) ||
    (row.transport !== 'cookie' && row.transport !== 'bearer' && row.transport !== 'api-key')
  ) {
    throw new Error('identity.sessions: a stored session is malformed');
  }
  return Object.freeze({
    id: row.id as Id<'Session'>,
    marketId: marketId.value,
    accountId: row.accountId as Id<'Account'>,
    population: row.population as Population,
    merchantId: row.merchantId as Id<'Merchant'> | null,
    transport: row.transport,
    label: row.label,
    device: parseDeviceCode(row.device),
    createdAt: toInstant(row.createdAt),
    lastSeenAt: toInstant(row.lastSeenAt),
    idleTimeoutSeconds: row.idleTimeoutSeconds,
    absoluteExpiresAt: toInstant(row.absoluteExpiresAt),
    revokedAt: row.revokedAt === null ? null : toInstant(row.revokedAt),
    revokedReason: row.revokedReason,
  });
}

/**
 * {@link SessionRepository} on `identity.sessions` (data design 3.4). Every statement goes
 * through `PrismaService.tx(market)` with `marketId` at the top level of `where`. The per-request
 * read is one call by the unique `(market_id, token_hash)`, with the account's status through
 * the relation (a nested read; nested writes are refused by the guard).
 */
export class PrismaSessionRepository implements SessionRepository {
  constructor(private readonly prisma: PrismaService) {}

  async add(market: MarketContext, session: Session, tokenHash: Uint8Array): Promise<void> {
    await this.prisma.tx(market).identitySession.create({
      data: {
        id: session.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        accountId: session.accountId,
        population: session.population,
        merchantId: session.merchantId,
        tokenHash: Uint8Array.from(tokenHash),
        transport: session.transport,
        device: session.device,
        label: session.label,
        createdAt: toDate(session.createdAt),
        lastSeenAt: toDate(session.lastSeenAt),
        idleTimeoutSeconds: session.idleTimeoutSeconds,
        absoluteExpiresAt: toDate(session.absoluteExpiresAt),
        revokedAt: session.revokedAt === null ? null : toDate(session.revokedAt),
        revokedReason: session.revokedReason,
      },
      select: { id: true },
    });
  }

  async findForAuthentication(
    market: MarketContext,
    tokenHash: Uint8Array,
  ): Promise<SessionForAuthentication | null> {
    // One call (6.2): the session, its account's status, the account's active membership (at
    // most one: the partial unique key) and the state of the session's merchant. The nested
    // reads follow composite foreign keys, so they stay in the session's Market (C3).
    const row = await this.prisma.tx(market).identitySession.findFirst({
      where: { marketId: market.marketId, tokenHash: Uint8Array.from(tokenHash) },
      select: {
        ...SELECTED,
        account: {
          select: {
            status: true,
            merchantMembership: {
              where: { state: 'active' },
              select: { merchantId: true },
              take: 1,
            },
          },
        },
        merchant: { select: { state: true } },
      },
    });
    if (row === null) return null;
    const status = row.account.status;
    if (status !== 'active' && status !== 'disabled') {
      throw new Error('identity.accounts: a stored account status is malformed');
    }
    const merchantState = row.merchant?.state ?? null;
    if (merchantState !== null && !(MERCHANT_STATES as readonly string[]).includes(merchantState)) {
      throw new Error('identity.merchants: a stored state is malformed');
    }
    return {
      session: restore(row),
      accountStatus: status,
      activeMembershipMerchantId:
        (row.account.merchantMembership[0]?.merchantId as Id<'Merchant'> | undefined) ?? null,
      merchantState: merchantState as MerchantStateCode | null,
    };
  }

  async findById(market: MarketContext, id: Id<'Session'>): Promise<Session | null> {
    const row = await this.prisma.tx(market).identitySession.findFirst({
      where: { marketId: market.marketId, id },
      select: SELECTED,
    });
    return row === null ? null : restore(row);
  }

  async listUnrevokedOf(
    market: MarketContext,
    accountId: Id<'Account'>,
    now: Temporal.Instant,
    limit: number,
  ): Promise<readonly Session[]> {
    // On the index (market_id, account_id) (data design 3.4); the idle timeout is decided by
    // the caller from the Clock, like every other expiry.
    const rows = await this.prisma.tx(market).identitySession.findMany({
      where: {
        marketId: market.marketId,
        accountId,
        revokedAt: null,
        absoluteExpiresAt: { gt: toDate(now) },
      },
      select: SELECTED,
      orderBy: [{ lastSeenAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map(restore);
  }

  async touch(
    market: MarketContext,
    id: Id<'Session'>,
    now: Temporal.Instant,
    lastSeenBefore: Temporal.Instant,
  ): Promise<void> {
    await this.prisma.tx(market).identitySession.updateMany({
      where: {
        marketId: market.marketId,
        id,
        revokedAt: null,
        lastSeenAt: { lte: toDate(lastSeenBefore) },
      },
      data: { lastSeenAt: toDate(now) },
    });
  }

  async revoke(
    market: MarketContext,
    id: Id<'Session'>,
    accountId: Id<'Account'>,
    reason: SessionRevokedReason,
    now: Temporal.Instant,
  ): Promise<boolean> {
    const { count } = await this.prisma.tx(market).identitySession.updateMany({
      where: { marketId: market.marketId, id, accountId, revokedAt: null },
      data: { revokedAt: toDate(now), revokedReason: reason },
    });
    return count === 1;
  }

  async revokeAllOf(
    market: MarketContext,
    accountId: Id<'Account'>,
    reason: SessionRevokedReason,
    now: Temporal.Instant,
    exceptId: Id<'Session'> | null,
  ): Promise<number> {
    // On the index (market_id, account_id) (data design 3.4).
    const { count } = await this.prisma.tx(market).identitySession.updateMany({
      where: {
        marketId: market.marketId,
        accountId,
        revokedAt: null,
        ...(exceptId === null ? {} : { id: { not: exceptId } }),
      },
      data: { revokedAt: toDate(now), revokedReason: reason },
    });
    return count;
  }

  async listApiKeysOf(
    market: MarketContext,
    merchantId: Id<'Merchant'>,
    now: Temporal.Instant,
  ): Promise<readonly Session[]> {
    // On the partial index sessions_market_id_merchant_id_idx.
    const rows = await this.prisma.tx(market).identitySession.findMany({
      where: {
        marketId: market.marketId,
        merchantId,
        transport: 'api-key',
        revokedAt: null,
        absoluteExpiresAt: { gt: toDate(now) },
      },
      select: SELECTED,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return rows.map(restore);
  }

  async revokeAllOfMerchant(
    market: MarketContext,
    merchantId: Id<'Merchant'>,
    reason: SessionRevokedReason,
    now: Temporal.Instant,
  ): Promise<number> {
    // On the partial index sessions_market_id_merchant_id_idx; the predicate
    // `merchant_id IS NOT NULL` is implied by the equality.
    const { count } = await this.prisma.tx(market).identitySession.updateMany({
      where: { marketId: market.marketId, merchantId, revokedAt: null },
      data: { revokedAt: toDate(now), revokedReason: reason },
    });
    return count;
  }

  async rotate(
    market: MarketContext,
    id: Id<'Session'>,
    accountId: Id<'Account'>,
    tokenHash: Uint8Array,
  ): Promise<boolean> {
    // By primary key; not a HOT update, because the token hash is indexed (data design 3.4).
    const { count } = await this.prisma.tx(market).identitySession.updateMany({
      where: { marketId: market.marketId, id, accountId, revokedAt: null },
      data: { tokenHash: Uint8Array.from(tokenHash) },
    });
    return count === 1;
  }

  async purgeExpired(market: MarketContext, expiredBefore: Temporal.Instant): Promise<number> {
    const { count } = await this.prisma.tx(market).identitySession.deleteMany({
      where: { marketId: market.marketId, absoluteExpiresAt: { lt: toDate(expiredBefore) } },
    });
    return count;
  }
}
