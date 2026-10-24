import { timingSafeEqual } from 'node:crypto';
import { parseMarketId, Temporal } from '@mondapac-drive/shared-kernel';
import type { Id, MarketContext } from '@mondapac-drive/shared-kernel';
import type { PrismaService } from '../../../../platform/persistence/prisma.service';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { OneTimeLinkRepository } from '../../application/ports/one-time-link.repository';
import {
  LINK_PURPOSES,
  OneTimeLink,
  type LinkPurpose,
  type OneTimeLinkState,
} from '../../domain/one-time-link';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toOptionalDate = (instant: Temporal.Instant | null): Date | null =>
  instant === null ? null : toDate(instant);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());
const toOptionalInstant = (date: Date | null): Temporal.Instant | null =>
  date === null ? null : toInstant(date);

/** One row per account and purpose (data design 3.7). */
const ONE_PER_PURPOSE = 'one_time_links_market_id_account_id_purpose_key';

const SELECTED = {
  id: true,
  marketId: true,
  accountId: true,
  purpose: true,
  requestedAt: true,
  tokenHash: true,
  issuedAt: true,
  expiresAt: true,
  consumedAt: true,
  version: true,
} as const;

interface SelectedRow {
  readonly id: string;
  readonly marketId: string;
  readonly accountId: string;
  readonly purpose: string;
  readonly requestedAt: Date;
  readonly tokenHash: Uint8Array | null;
  readonly issuedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly consumedAt: Date | null;
  readonly version: number;
}

/**
 * {@link OneTimeLinkRepository} on `identity.one_time_links` (data design 3.7). Every statement
 * goes through `PrismaService.tx(market)` with `marketId` at the top level of `where` (P 4);
 * single statements, never nested (C10). The token hash is the only secret here; it is never
 * logged.
 */
export class PrismaOneTimeLinkRepository implements OneTimeLinkRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(market: MarketContext, id: Id<'OneTimeLink'>): Promise<OneTimeLink | null> {
    const row = await this.prisma.tx(market).identityOneTimeLink.findFirst({
      where: { marketId: market.marketId, id },
      select: SELECTED,
    });
    return row === null ? null : restore(row);
  }

  async findFor(
    market: MarketContext,
    accountId: Id<'Account'>,
    purpose: LinkPurpose,
  ): Promise<OneTimeLink | null> {
    const row = await this.prisma.tx(market).identityOneTimeLink.findFirst({
      where: { marketId: market.marketId, accountId, purpose },
      select: SELECTED,
    });
    return row === null ? null : restore(row);
  }

  async findByTokenHash(market: MarketContext, tokenHash: Uint8Array): Promise<OneTimeLink | null> {
    const presented = Uint8Array.from(tokenHash);
    const row = await this.prisma.tx(market).identityOneTimeLink.findFirst({
      where: { marketId: market.marketId, tokenHash: presented },
      select: SELECTED,
    });
    // The index found the row by equality; the constant-time comparison is defence in depth,
    // so no code path ever compares a token hash byte by byte with an early exit.
    if (
      row === null ||
      row.tokenHash === null ||
      row.tokenHash.length !== presented.length ||
      !timingSafeEqual(row.tokenHash, presented)
    ) {
      return null;
    }
    return restore(row);
  }

  async add(market: MarketContext, link: OneTimeLink): Promise<void> {
    const state = link.state;
    try {
      await this.prisma.tx(market).identityOneTimeLink.create({
        data: {
          id: state.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          accountId: state.accountId,
          purpose: state.purpose,
          ...this.columns(state),
        },
        select: { id: true },
      });
    } catch (error) {
      // A concurrent request created the row of this account and purpose first (M8).
      if (this.prisma.violatedConstraint(error) === ONE_PER_PURPOSE) {
        throw new StaleAggregateError('one-time-link', state.id);
      }
      throw error;
    }
  }

  async save(market: MarketContext, link: OneTimeLink): Promise<void> {
    const state = link.state;
    const expected = link.persistedVersion;
    if (expected === null) throw new Error('save: the link was never stored; use add');
    if (state.version === expected) return;
    const { count } = await this.prisma.tx(market).identityOneTimeLink.updateMany({
      where: { marketId: market.marketId, id: state.id, version: expected },
      data: this.columns(state),
    });
    if (count !== 1) throw new StaleAggregateError('one-time-link', state.id);
  }

  async consume(
    market: MarketContext,
    id: Id<'OneTimeLink'>,
    expectedVersion: number,
    now: Temporal.Instant,
  ): Promise<boolean> {
    const at = toDate(now);
    const { count } = await this.prisma.tx(market).identityOneTimeLink.updateMany({
      where: {
        marketId: market.marketId,
        id,
        version: expectedVersion,
        consumedAt: null,
        expiresAt: { gt: at },
      },
      data: { consumedAt: at, version: { increment: 1 } },
    });
    return count === 1;
  }

  async cancelUnused(
    market: MarketContext,
    accountId: Id<'Account'>,
    purpose: LinkPurpose,
  ): Promise<boolean> {
    // On the unique key (market_id, account_id, purpose) (M8): at most one row.
    const { count } = await this.prisma.tx(market).identityOneTimeLink.updateMany({
      where: { marketId: market.marketId, accountId, purpose, consumedAt: null },
      data: { tokenHash: null, issuedAt: null, expiresAt: null, version: { increment: 1 } },
    });
    return count === 1;
  }

  async purgeSpent(market: MarketContext, before: Temporal.Instant): Promise<number> {
    const at = toDate(before);
    const { count } = await this.prisma.tx(market).identityOneTimeLink.deleteMany({
      where: {
        marketId: market.marketId,
        OR: [{ consumedAt: { lt: at } }, { expiresAt: { lt: at } }],
      },
    });
    return count;
  }

  private columns(state: OneTimeLinkState) {
    return {
      requestedAt: toDate(state.requestedAt),
      tokenHash: state.tokenHash === null ? null : Uint8Array.from(state.tokenHash),
      issuedAt: toOptionalDate(state.issuedAt),
      expiresAt: toOptionalDate(state.expiresAt),
      consumedAt: toOptionalDate(state.consumedAt),
      version: state.version,
    };
  }
}

function restore(row: SelectedRow): OneTimeLink {
  const marketId = parseMarketId(row.marketId);
  if (!marketId.ok || !(LINK_PURPOSES as readonly string[]).includes(row.purpose)) {
    throw new Error('identity.one_time_links: a stored link is malformed');
  }
  return OneTimeLink.restore({
    id: row.id as Id<'OneTimeLink'>,
    marketId: marketId.value,
    accountId: row.accountId as Id<'Account'>,
    purpose: row.purpose as LinkPurpose,
    requestedAt: toInstant(row.requestedAt),
    tokenHash: row.tokenHash === null ? null : Uint8Array.from(row.tokenHash),
    issuedAt: toOptionalInstant(row.issuedAt),
    expiresAt: toOptionalInstant(row.expiresAt),
    consumedAt: toOptionalInstant(row.consumedAt),
    version: row.version,
  });
}
