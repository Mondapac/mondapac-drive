import { Temporal } from '@mondapac-drive/shared-kernel';
import type { MarketContext } from '@mondapac-drive/shared-kernel';
import type { PrismaService } from '../../../../platform/persistence/prisma.service';
import type {
  ThrottleBlock,
  ThrottleCounter,
  ThrottleRepository,
} from '../../application/ports/throttle.repository';
import {
  THROTTLE_KINDS,
  windowRestartBefore,
  type ThrottleReservation,
} from '../../domain/throttle';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

/** Kind first, then key bytes: the fixed order of data design 3.5, so no cycle of waits. */
function inLockOrder(a: ThrottleCounter, b: ThrottleCounter): number {
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  return Buffer.compare(a.keyHash, b.keyHash);
}

/** The counters of an address that a password reset clears (identity design 3.7, AC 13). */
const SIGN_IN_ACCOUNT_KINDS = ['sign-in.account', 'sign-in.account-origin'] as const;

/**
 * {@link ThrottleRepository} on `identity.sign_in_throttles` (data design 3.5). Per counter, two
 * statements (C10): an `updateMany` that restarts an ended window, then an `upsert` on the
 * primary key that Prisma sends as one `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` (spike 6:
 * 20 concurrent units allowed exactly the limit). Release and block touch only the reserved
 * window: a window restarted in between is left alone.
 */
export class PrismaThrottleRepository implements ThrottleRepository {
  constructor(private readonly prisma: PrismaService) {}

  async reserve(
    market: MarketContext,
    counters: readonly ThrottleCounter[],
    now: Temporal.Instant,
  ): Promise<ThrottleReservation[]> {
    const transaction = this.prisma.tx(market);
    const reserved = new Map<ThrottleCounter, ThrottleReservation>();
    for (const counter of [...counters].sort(inLockOrder)) {
      if (!(THROTTLE_KINDS as readonly string[]).includes(counter.kind)) {
        throw new TypeError('reserve: unknown throttle kind');
      }
      const keyHash = Uint8Array.from(counter.keyHash);
      await transaction.identitySignInThrottle.updateMany({
        where: {
          marketId: market.marketId,
          kind: counter.kind,
          keyHash,
          windowStartedAt: { lte: toDate(windowRestartBefore(counter.rule, now)) },
        },
        data: { attempts: 0, windowStartedAt: toDate(now) },
      });
      const row = await transaction.identitySignInThrottle.upsert({
        where: {
          marketId: market.marketId,
          marketId_kind_keyHash: { marketId: market.marketId, kind: counter.kind, keyHash },
        },
        create: {
          marketId: market.marketId,
          tenantId: market.tenantId,
          kind: counter.kind,
          keyHash,
          accountKey: counter.accountKey === null ? null : Uint8Array.from(counter.accountKey),
          windowStartedAt: toDate(now),
          attempts: 1,
          blockedUntil: null,
        },
        update: { attempts: { increment: 1 } },
        select: { attempts: true, windowStartedAt: true, blockedUntil: true },
      });
      reserved.set(counter, {
        kind: counter.kind,
        keyHash: counter.keyHash,
        attempts: row.attempts,
        windowStartedAt: toInstant(row.windowStartedAt),
        blockedUntil: row.blockedUntil === null ? null : toInstant(row.blockedUntil),
      });
    }
    return counters.map((counter) => reserved.get(counter)!);
  }

  async release(
    market: MarketContext,
    reservations: readonly ThrottleReservation[],
  ): Promise<void> {
    const transaction = this.prisma.tx(market);
    for (const reservation of [...reservations].sort(byLockOrder)) {
      await transaction.identitySignInThrottle.updateMany({
        where: {
          ...this.reserved(market, reservation),
          attempts: { gt: 0 },
        },
        data: { attempts: { decrement: 1 } },
      });
    }
  }

  async block(market: MarketContext, blocks: readonly ThrottleBlock[]): Promise<void> {
    const transaction = this.prisma.tx(market);
    const ordered = [...blocks].sort((a, b) => byLockOrder(a.reservation, b.reservation));
    for (const { reservation, until } of ordered) {
      await transaction.identitySignInThrottle.updateMany({
        where: this.reserved(market, reservation),
        data: { blockedUntil: toDate(until) },
      });
    }
  }

  async clearAccount(market: MarketContext, accountKey: Uint8Array): Promise<number> {
    // On the index (market_id, account_key) (data design 3.5). A deadlock with a concurrent
    // reservation of the same address is retried by the unit of work (40P01, P 3.1 row 7).
    const { count } = await this.prisma.tx(market).identitySignInThrottle.deleteMany({
      where: {
        marketId: market.marketId,
        accountKey: Uint8Array.from(accountKey),
        kind: { in: [...SIGN_IN_ACCOUNT_KINDS] },
      },
    });
    return count;
  }

  async purge(
    market: MarketContext,
    windowStartedBefore: Temporal.Instant,
    now: Temporal.Instant,
  ): Promise<number> {
    const { count } = await this.prisma.tx(market).identitySignInThrottle.deleteMany({
      where: {
        marketId: market.marketId,
        windowStartedAt: { lt: toDate(windowStartedBefore) },
        OR: [{ blockedUntil: null }, { blockedUntil: { lte: toDate(now) } }],
      },
    });
    return count;
  }

  private reserved(market: MarketContext, reservation: ThrottleReservation) {
    return {
      marketId: market.marketId,
      kind: reservation.kind,
      keyHash: Uint8Array.from(reservation.keyHash),
      windowStartedAt: toDate(reservation.windowStartedAt),
    };
  }
}

function byLockOrder(a: ThrottleReservation, b: ThrottleReservation): number {
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  return Buffer.compare(a.keyHash, b.keyHash);
}
