import { parseMarketId, Temporal } from '@mondapac-drive/shared-kernel';
import type { Id, MarketContext } from '@mondapac-drive/shared-kernel';
import type { PrismaService } from '../../../../platform/persistence/prisma.service';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { SecondFactorRepository } from '../../application/ports/second-factor.repository';
import {
  SECOND_FACTOR_STATES,
  SecondFactor,
  type SecondFactorState,
  type SecondFactorStateCode,
  type StoredRecoveryCode,
} from '../../domain/second-factor';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toOptionalDate = (instant: Temporal.Instant | null): Date | null =>
  instant === null ? null : toDate(instant);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());
const toOptionalInstant = (date: Date | null): Temporal.Instant | null =>
  date === null ? null : toInstant(date);

/** One factor per account (data design 3.10). */
const ONE_PER_ACCOUNT = 'second_factors_market_id_account_id_key';

const SELECTED = {
  id: true,
  marketId: true,
  accountId: true,
  state: true,
  secretCiphertext: true,
  pendingSecretCiphertext: true,
  lastAcceptedStep: true,
  activatedAt: true,
  lockedAt: true,
  createdAt: true,
  version: true,
} as const;

interface FactorRow {
  readonly id: string;
  readonly marketId: string;
  readonly accountId: string;
  readonly state: string;
  readonly secretCiphertext: string;
  readonly pendingSecretCiphertext: string | null;
  readonly lastAcceptedStep: number | null;
  readonly activatedAt: Date | null;
  readonly lockedAt: Date | null;
  readonly createdAt: Date;
  readonly version: number;
}

interface CodeRow {
  readonly position: number;
  readonly codeHash: Uint8Array;
  readonly usedAt: Date | null;
}

/**
 * {@link SecondFactorRepository} on `identity.second_factors` and `identity.recovery_codes`
 * (data design 3.10). Every statement goes through `PrismaService.tx(market)` with `marketId` at
 * the top level of `where` (P 4); single-table statements, never nested writes (C10). The
 * factor is read by its `(market_id, account_id)` key and its codes by the primary key's prefix
 * `(market_id, second_factor_id)`. Ciphertext and keyed hashes only; nothing here is logged.
 */
export class PrismaSecondFactorRepository implements SecondFactorRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByAccount(
    market: MarketContext,
    accountId: Id<'Account'>,
  ): Promise<SecondFactor | null> {
    const tx = this.prisma.tx(market);
    const row = await tx.identitySecondFactor.findFirst({
      where: { marketId: market.marketId, accountId },
      select: SELECTED,
    });
    if (row === null) return null;
    const codes = await tx.identityRecoveryCode.findMany({
      where: { marketId: market.marketId, secondFactorId: row.id },
      select: { position: true, codeHash: true, usedAt: true },
      orderBy: { position: 'asc' },
    });
    return restore(row, codes);
  }

  async add(market: MarketContext, factor: SecondFactor): Promise<void> {
    const state = factor.state;
    if (factor.persistedVersion !== null) throw new Error('add: the factor is already stored');
    const tx = this.prisma.tx(market);
    try {
      await tx.identitySecondFactor.create({
        data: {
          id: state.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          accountId: state.accountId,
          createdAt: toDate(state.createdAt),
          ...columns(state),
        },
        select: { id: true },
      });
    } catch (error) {
      // A concurrent enrolment stored the account's factor first (one per account).
      if (this.prisma.violatedConstraint(error) === ONE_PER_ACCOUNT) {
        throw new StaleAggregateError('second-factor', state.id);
      }
      throw error;
    }
    await this.insertCodes(market, state);
  }

  async save(market: MarketContext, factor: SecondFactor): Promise<void> {
    const state = factor.state;
    const expected = factor.persistedVersion;
    if (expected === null) throw new Error('save: the factor was never stored; use add');
    if (state.version === expected) return;
    const tx = this.prisma.tx(market);
    const { count } = await tx.identitySecondFactor.updateMany({
      where: { marketId: market.marketId, id: state.id, version: expected },
      data: columns(state),
    });
    if (count !== 1) throw new StaleAggregateError('second-factor', state.id);
    // The codes are rewritten whole: activation and regeneration replace all ten, and a spent
    // code is kept as spent. The version guard above makes this the only writer of this state.
    await tx.identityRecoveryCode.deleteMany({
      where: { marketId: market.marketId, secondFactorId: state.id },
    });
    await this.insertCodes(market, state);
  }

  async acceptStep(market: MarketContext, id: Id<'SecondFactor'>, step: number): Promise<boolean> {
    if (!Number.isSafeInteger(step) || step < 0 || step > 2147483647) return false;
    const { count } = await this.prisma.tx(market).identitySecondFactor.updateMany({
      where: {
        marketId: market.marketId,
        id,
        state: 'active',
        OR: [{ lastAcceptedStep: null }, { lastAcceptedStep: { lt: step } }],
      },
      data: { lastAcceptedStep: step, version: { increment: 1 } },
    });
    return count === 1;
  }

  async useRecoveryCode(
    market: MarketContext,
    id: Id<'SecondFactor'>,
    codeHash: Uint8Array,
    now: Temporal.Instant,
  ): Promise<boolean> {
    if (codeHash.length !== 32) return false;
    const tx = this.prisma.tx(market);
    const unused = {
      marketId: market.marketId,
      secondFactorId: id,
      codeHash: Uint8Array.from(codeHash),
      usedAt: null,
    };
    // A wrong code writes nothing: the unused code is looked up first, on the primary key's
    // prefix, without a lock.
    const candidate = await tx.identityRecoveryCode.findFirst({
      where: unused,
      select: { position: true },
    });
    if (candidate === null) return false;
    // Then the root, in the lock order of every writer of a factor (root, then its codes), so a
    // use never waits in a cycle with a save: it must be active, and raising its version makes a
    // save of the factor loaded before this use fail as stale, so a spent code never comes back.
    const root = await tx.identitySecondFactor.updateMany({
      where: { marketId: market.marketId, id, state: 'active' },
      data: { version: { increment: 1 } },
    });
    if (root.count !== 1) return false;
    // The single use: a concurrent use of the same code waited on the root and finds it spent.
    const spent = await tx.identityRecoveryCode.updateMany({
      where: { ...unused, position: candidate.position },
      data: { usedAt: toDate(now) },
    });
    return spent.count === 1;
  }

  async removeOf(market: MarketContext, accountId: Id<'Account'>): Promise<boolean> {
    // The codes go by the cascade from second_factors (data design C8).
    const { count } = await this.prisma.tx(market).identitySecondFactor.deleteMany({
      where: { marketId: market.marketId, accountId },
    });
    return count === 1;
  }

  async activeAmong(
    market: MarketContext,
    accountIds: readonly Id<'Account'>[],
  ): Promise<ReadonlySet<Id<'Account'>>> {
    const ids = [...new Set(accountIds)];
    if (ids.length === 0) return new Set();
    const rows = await this.prisma.tx(market).identitySecondFactor.findMany({
      where: { marketId: market.marketId, accountId: { in: ids }, state: 'active' },
      select: { accountId: true },
    });
    return new Set(rows.map((row) => row.accountId as Id<'Account'>));
  }

  async presentAmong(
    market: MarketContext,
    accountIds: readonly Id<'Account'>[],
  ): Promise<ReadonlySet<Id<'Account'>>> {
    const ids = [...new Set(accountIds)];
    if (ids.length === 0) return new Set();
    // The `(market_id, account_id)` key; the account id is the only column read.
    const rows = await this.prisma.tx(market).identitySecondFactor.findMany({
      where: { marketId: market.marketId, accountId: { in: ids } },
      select: { accountId: true },
    });
    return new Set(rows.map((row) => row.accountId as Id<'Account'>));
  }

  private async insertCodes(market: MarketContext, state: SecondFactorState): Promise<void> {
    if (state.recoveryCodes.length === 0) return;
    await this.prisma.tx(market).identityRecoveryCode.createMany({
      data: state.recoveryCodes.map((code) => ({
        marketId: market.marketId,
        tenantId: market.tenantId,
        secondFactorId: state.id,
        position: code.position,
        codeHash: Uint8Array.from(code.codeHash),
        usedAt: toOptionalDate(code.usedAt),
      })),
    });
  }
}

/** The columns a save writes: everything but the identity of the row. */
function columns(state: SecondFactorState) {
  return {
    state: state.state,
    secretCiphertext: state.secretCiphertext,
    pendingSecretCiphertext: state.pendingSecretCiphertext,
    lastAcceptedStep: state.lastAcceptedStep,
    activatedAt: toOptionalDate(state.activatedAt),
    lockedAt: toOptionalDate(state.lockedAt),
    version: state.version,
  };
}

function restore(row: FactorRow, codes: readonly CodeRow[]): SecondFactor {
  const marketId = parseMarketId(row.marketId);
  if (!marketId.ok || !(SECOND_FACTOR_STATES as readonly string[]).includes(row.state)) {
    throw new Error('identity.second_factors: a stored factor is malformed');
  }
  return SecondFactor.restore({
    id: row.id as Id<'SecondFactor'>,
    marketId: marketId.value,
    accountId: row.accountId as Id<'Account'>,
    state: row.state as SecondFactorStateCode,
    secretCiphertext: row.secretCiphertext,
    pendingSecretCiphertext: row.pendingSecretCiphertext,
    lastAcceptedStep: row.lastAcceptedStep,
    activatedAt: toOptionalInstant(row.activatedAt),
    lockedAt: toOptionalInstant(row.lockedAt),
    createdAt: toInstant(row.createdAt),
    recoveryCodes: codes.map((code): StoredRecoveryCode => ({
      position: code.position,
      codeHash: Uint8Array.from(code.codeHash),
      usedAt: toOptionalInstant(code.usedAt),
    })),
    version: row.version,
  });
}
