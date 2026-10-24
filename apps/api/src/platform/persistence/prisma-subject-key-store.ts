import { ok, Temporal } from '@mondapac-drive/shared-kernel';
import type { Id, MarketContext } from '@mondapac-drive/shared-kernel';
import { SubjectKeyExistsError, SubjectKeyMissingError } from '../subject-keys/subject-key-service';
import type {
  NewSubjectKey,
  StoredSubjectKey,
  SubjectKeyStore,
} from '../subject-keys/subject-key-store';
import type { UnitOfWork } from '../unit-of-work/unit-of-work';
import { reduceDatabaseError } from './database-error';
import type { MarketTransaction } from './guarded-client';
import type { PrismaService } from './prisma.service';
import { unitStorage } from './unit-store';

/** The columns the service reads; never `created_at` or `rewrapped_at`. */
const SELECTED = {
  subjectId: true,
  keyVersion: true,
  wrappedKey: true,
  wrappingKeyId: true,
  destroyedAt: true,
} as const;

/**
 * The key table `platform.subject_keys` (data design 3.2) behind the SubjectKeyService (PF 4
 * row 13). Every statement goes through `PrismaService.tx(market)` with `marketId` at the top
 * level of `where`, so the market guard checks it like any other query (P 4).
 *
 * - `insert` and `destroy` run in the caller's open read-write unit (PF 4 row 8); without one,
 *   `tx` throws `NoUnitOfWorkError`, and a read-only unit's guard refuses the write.
 * - `find` uses the open unit when there is one, so a registration reads its own uncommitted
 *   key; otherwise it opens a read-only unit of its own (P 3.3).
 */
export class PrismaSubjectKeyStore implements SubjectKeyStore {
  constructor(
    private readonly prisma: PrismaService,
    private readonly unitOfWork: UnitOfWork,
  ) {}

  async insert(market: MarketContext, key: NewSubjectKey): Promise<void> {
    try {
      await this.prisma.tx(market).subjectKey.create({
        data: {
          subjectId: key.subjectId,
          marketId: market.marketId,
          tenantId: market.tenantId,
          keyVersion: key.keyVersion,
          wrappedKey: key.wrappedKey,
          wrappingKeyId: key.wrappingKeyId,
          createdAt: new Date(key.createdAt.epochMilliseconds),
        },
        select: { subjectId: true },
      });
    } catch (error) {
      // The primary key on the subject alone: one key for life, in any Market (PF 4 row 5).
      if (reduceDatabaseError(error)?.constraint === 'subject_keys_pkey') {
        throw new SubjectKeyExistsError();
      }
      throw error;
    }
  }

  async find(market: MarketContext, subjectId: Id): Promise<StoredSubjectKey | null> {
    const unit = unitStorage.getStore();
    if (unit !== undefined && !unit.closed)
      return this.read(this.prisma.tx(market), market, subjectId);
    const result = await this.unitOfWork.run(
      market,
      async () => ok(await this.read(this.prisma.tx(market), market, subjectId)),
      { readOnly: true },
    );
    // The work never answers err; if a unit ever did, "no key" would be a wrong answer, so it
    // throws rather than return null (Mojtaba's review of slice 1c, note 5).
    if (!result.ok) throw new Error('The read-only unit of the subject-key store answered err');
    return result.value;
  }

  async destroy(
    market: MarketContext,
    subjectId: Id,
    destroyedAt: Temporal.Instant,
  ): Promise<void> {
    const transaction = this.prisma.tx(market);
    // One guarded statement: a second call changes no row (data design 3.2).
    const { count } = await transaction.subjectKey.updateMany({
      where: { marketId: market.marketId, subjectId, destroyedAt: null },
      data: { wrappedKey: null, destroyedAt: new Date(destroyedAt.epochMilliseconds) },
    });
    if (count === 0 && (await this.read(transaction, market, subjectId)) === null) {
      throw new SubjectKeyMissingError();
    }
  }

  private async read(
    transaction: MarketTransaction,
    market: MarketContext,
    subjectId: Id,
  ): Promise<StoredSubjectKey | null> {
    const row = await transaction.subjectKey.findFirst({
      where: { marketId: market.marketId, subjectId },
      select: SELECTED,
    });
    if (row === null) return null;
    return {
      subjectId: row.subjectId as Id,
      keyVersion: row.keyVersion,
      wrappedKey: row.wrappedKey,
      wrappingKeyId: row.wrappingKeyId,
      destroyedAt:
        row.destroyedAt === null
          ? null
          : Temporal.Instant.fromEpochMilliseconds(row.destroyedAt.getTime()),
    };
  }
}
