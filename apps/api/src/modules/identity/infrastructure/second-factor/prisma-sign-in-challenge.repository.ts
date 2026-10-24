import { timingSafeEqual } from 'node:crypto';
import { parseMarketId, Temporal } from '@mondapac-drive/shared-kernel';
import type { Id, MarketContext } from '@mondapac-drive/shared-kernel';
import type { PrismaService } from '../../../../platform/persistence/prisma.service';
import type { SignInChallengeRepository } from '../../application/ports/sign-in-challenge.repository';
import {
  CHALLENGE_PURPOSES,
  type ChallengePurpose,
  type SignInChallenge,
} from '../../domain/sign-in-challenge';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

/** `attempts` is a smallint (data design 3.10). */
const MAX_STORED_ATTEMPTS = 32767;

const SELECTED = {
  id: true,
  marketId: true,
  accountId: true,
  purpose: true,
  tokenHash: true,
  attempts: true,
  credentialChangedAt: true,
  expiresAt: true,
  consumedAt: true,
  createdAt: true,
} as const;

/**
 * {@link SignInChallengeRepository} on `identity.sign_in_challenges` (data design 3.10). Every
 * statement goes through `PrismaService.tx(market)` with `marketId` at the top level of `where`
 * (P 4). A challenge changes only by single guarded statements (M1): the attempt reservation of
 * HF1, the consumption and the deletion that voids it (HF11). The token hash is the only secret
 * here; it is never logged.
 */
export class PrismaSignInChallengeRepository implements SignInChallengeRepository {
  constructor(private readonly prisma: PrismaService) {}

  async add(
    market: MarketContext,
    challenge: SignInChallenge,
    tokenHash: Uint8Array,
  ): Promise<void> {
    if (tokenHash.length !== 32) throw new RangeError('add: a 32-byte token hash is required');
    await this.prisma.tx(market).identitySignInChallenge.create({
      data: {
        id: challenge.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        accountId: challenge.accountId,
        purpose: challenge.purpose,
        tokenHash: Uint8Array.from(tokenHash),
        attempts: challenge.attempts,
        credentialChangedAt: toDate(challenge.credentialChangedAt),
        expiresAt: toDate(challenge.expiresAt),
        consumedAt: challenge.consumedAt === null ? null : toDate(challenge.consumedAt),
        createdAt: toDate(challenge.createdAt),
      },
      select: { id: true },
    });
  }

  async findByTokenHash(
    market: MarketContext,
    tokenHash: Uint8Array,
  ): Promise<SignInChallenge | null> {
    const presented = Uint8Array.from(tokenHash);
    const row = await this.prisma.tx(market).identitySignInChallenge.findFirst({
      where: { marketId: market.marketId, tokenHash: presented },
      select: SELECTED,
    });
    // Found by equality on the unique index; the constant-time comparison is defence in depth.
    if (
      row === null ||
      row.tokenHash.length !== presented.length ||
      !timingSafeEqual(row.tokenHash, presented)
    ) {
      return null;
    }
    const marketId = parseMarketId(row.marketId);
    if (!marketId.ok || !(CHALLENGE_PURPOSES as readonly string[]).includes(row.purpose)) {
      throw new Error('identity.sign_in_challenges: a stored challenge is malformed');
    }
    return Object.freeze({
      id: row.id as Id<'SignInChallenge'>,
      marketId: marketId.value,
      accountId: row.accountId as Id<'Account'>,
      purpose: row.purpose as ChallengePurpose,
      attempts: row.attempts,
      credentialChangedAt: toInstant(row.credentialChangedAt),
      expiresAt: toInstant(row.expiresAt),
      consumedAt: row.consumedAt === null ? null : toInstant(row.consumedAt),
      createdAt: toInstant(row.createdAt),
    });
  }

  async reserveAttempt(
    market: MarketContext,
    id: Id<'SignInChallenge'>,
    maxAttempts: number,
    now: Temporal.Instant,
  ): Promise<boolean> {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_STORED_ATTEMPTS) {
      throw new RangeError('reserveAttempt: a positive whole limit within a smallint');
    }
    const { count } = await this.prisma.tx(market).identitySignInChallenge.updateMany({
      where: {
        marketId: market.marketId,
        id,
        attempts: { lt: maxAttempts },
        consumedAt: null,
        expiresAt: { gt: toDate(now) },
      },
      data: { attempts: { increment: 1 } },
    });
    return count === 1;
  }

  async consume(
    market: MarketContext,
    id: Id<'SignInChallenge'>,
    now: Temporal.Instant,
  ): Promise<boolean> {
    const at = toDate(now);
    const { count } = await this.prisma.tx(market).identitySignInChallenge.updateMany({
      where: { marketId: market.marketId, id, consumedAt: null, expiresAt: { gt: at } },
      data: { consumedAt: at },
    });
    return count === 1;
  }

  async voidAllOf(market: MarketContext, accountId: Id<'Account'>): Promise<number> {
    // On the index (market_id, account_id), which also serves the cascade from accounts.
    const { count } = await this.prisma.tx(market).identitySignInChallenge.deleteMany({
      where: { marketId: market.marketId, accountId },
    });
    return count;
  }

  async purgeExpired(market: MarketContext, before: Temporal.Instant): Promise<number> {
    // Rows live minutes, so the table stays small and needs no index of its own (data design 9).
    const { count } = await this.prisma.tx(market).identitySignInChallenge.deleteMany({
      where: { marketId: market.marketId, expiresAt: { lt: toDate(before) } },
    });
    return count;
  }
}
