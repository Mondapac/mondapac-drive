import { Temporal } from '@mondapac-drive/shared-kernel';
import type { MarketContext } from '@mondapac-drive/shared-kernel';
import { AUDIT_TIME_RANGE } from '../../audit/audit-chain-policy';
import {
  CheckpointConflictError,
  compareKeys,
  SealInsertConflictError,
  type AuditChainStore,
  type CheckpointRecord,
  type OutOfRangeSealScope,
  type SealKey,
  type SealPosition,
  type SealRecord,
  type SealWithRow,
  type Watermark,
} from '../../audit/audit-chain-store';
import type { AuditRowRecord } from '../../audit/audit-hash';
import { classifyConflict } from '../conflict-classifier';
import { reduceDatabaseError } from '../database-error';
import { auditTx } from './audit-transaction';

/** The constraints a seal insert can meet (docs/design/data/platform.md 11.3, 11.8). */
export const SEAL_PRIMARY_KEY = 'audit_log_seal_pkey';
export const SEAL_ROW_KEY = 'audit_log_seal_market_id_epoch_occurred_at_id_key';

/** The checkpoint's primary key (DP 11.4). */
export const CHECKPOINT_PRIMARY_KEY = 'audit_chain_checkpoint_pkey';

const UNIQUE_VIOLATION = '23505';

/**
 * Every read is bounded to AUDIT_TIME_RANGE: `infinity`, `-infinity` or a year past 275760
 * would come back as an Invalid Date and stop the sealer or crash the verifier (Hassan M1).
 * The `...OutOfRange` reads name such rows by id, selecting no time column.
 */
const MIN_TIME = new Date(AUDIT_TIME_RANGE.from.epochMilliseconds);
const UNTIL_TIME = new Date(AUDIT_TIME_RANGE.until.epochMilliseconds);
const IN_RANGE = { gte: MIN_TIME, lt: UNTIL_TIME };
/** A seal's two time columns in range. */
const SEAL_TIMES = { sealedAt: IN_RANGE, auditOccurredAt: IN_RANGE };

/** The Prisma row of `platform.audit_log`, as the guarded delegate returns it. */
interface AuditLogRow {
  readonly id: string;
  readonly marketId: string;
  readonly tenantId: string;
  readonly occurredAt: Date;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly actingAsId: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly correlationId: string;
}

interface SealRow {
  readonly epoch: number;
  readonly chainSeq: bigint;
  readonly auditLogId: string;
  readonly auditOccurredAt: Date;
  readonly rowHash: Uint8Array;
  readonly chainHash: Uint8Array;
  readonly late: boolean;
  readonly hashVersion: number;
  readonly sealedAt: Date;
}

interface CheckpointRow {
  readonly epoch: number;
  readonly chainSeq: bigint;
  readonly chainHash: Uint8Array;
  readonly hashVersion: number;
  readonly createdAt: Date;
}

const instantOf = (date: Date) => Temporal.Instant.fromEpochMilliseconds(date.getTime());
const dateOf = (instant: Temporal.Instant) => new Date(instant.epochMilliseconds);
const bytes = (value: Uint8Array) => Uint8Array.from(value);

function rowOf(row: AuditLogRow): AuditRowRecord {
  return {
    id: row.id,
    marketId: row.marketId,
    tenantId: row.tenantId,
    occurredAt: instantOf(row.occurredAt),
    actorType: row.actorType,
    actorId: row.actorId,
    actingAsId: row.actingAsId,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    before: row.before,
    after: row.after,
    correlationId: row.correlationId,
  };
}

function sealOf(row: SealRow): SealRecord {
  return {
    epoch: row.epoch,
    chainSeq: row.chainSeq,
    auditLogId: row.auditLogId,
    auditOccurredAt: instantOf(row.auditOccurredAt),
    rowHash: bytes(row.rowHash),
    chainHash: bytes(row.chainHash),
    late: row.late,
    hashVersion: row.hashVersion,
    sealedAt: instantOf(row.sealedAt),
  };
}

function checkpointOf(row: CheckpointRow): CheckpointRecord {
  return {
    epoch: row.epoch,
    chainSeq: row.chainSeq,
    chainHash: bytes(row.chainHash),
    hashVersion: row.hashVersion,
    createdAt: instantOf(row.createdAt),
  };
}

/** `(occurred_at, id) > key` in the one-index-range form of DP 11.8, as `AND` parts. */
function above(key: SealKey) {
  const at = dateOf(key.occurredAt);
  return [
    { occurredAt: { gte: at } },
    { OR: [{ occurredAt: { gt: at } }, { id: { gt: key.auditLogId } }] },
  ];
}

/** `(occurred_at, id) <= key`, as `AND` parts. */
function atOrBelow(key: SealKey) {
  const at = dateOf(key.occurredAt);
  return [
    { occurredAt: { lte: at } },
    { OR: [{ occurredAt: { lt: at } }, { id: { lte: key.auditLogId } }] },
  ];
}

const ROW_ORDER = [{ occurredAt: 'asc' as const }, { id: 'asc' as const }];

/**
 * The {@link AuditChainStore} on the audit models of the open unit (`auditTx`), so every
 * statement passes the market guard and runs in the caller's unit: the sealer's read-write
 * unit or the verifier's read-only one (ADR-0025). The access paths are those Mojtaba measured
 * (docs/design/data/platform.md 11.7, 11.8); no raw SQL, no row lock (the application role
 * cannot take one on these tables, F5). Every read is bounded to AUDIT_TIME_RANGE.
 */
export class PrismaAuditChainStore implements AuditChainStore {
  async lastSeals(market: MarketContext, epoch: number, count: number): Promise<SealRecord[]> {
    const rows = await auditTx(market).auditLogSeal.findMany({
      where: { marketId: market.marketId, epoch, ...SEAL_TIMES },
      orderBy: { chainSeq: 'desc' },
      take: count,
    });
    return rows.map(sealOf);
  }

  async watermark(market: MarketContext, epoch: number): Promise<Watermark | null> {
    const row = await auditTx(market).auditLogSeal.findFirst({
      where: { marketId: market.marketId, epoch, ...SEAL_TIMES },
      orderBy: [{ auditOccurredAt: 'desc' }, { auditLogId: 'desc' }],
      select: { auditOccurredAt: true, auditLogId: true, chainSeq: true },
    });
    return row === null
      ? null
      : {
          occurredAt: instantOf(row.auditOccurredAt),
          auditLogId: row.auditLogId,
          chainSeq: row.chainSeq,
        };
  }

  async rowsAbove(
    market: MarketContext,
    after: SealKey | null,
    settledUntil: Temporal.Instant,
    limit: number,
  ): Promise<AuditRowRecord[]> {
    const rows = await auditTx(market).auditLog.findMany({
      where: {
        marketId: market.marketId,
        AND: [
          { occurredAt: IN_RANGE },
          { occurredAt: { lte: dateOf(settledUntil) } },
          ...(after === null ? [] : above(after)),
        ],
      },
      orderBy: ROW_ORDER,
      take: limit,
    });
    return rows.map(rowOf);
  }

  async unsealedRows(
    market: MarketContext,
    epoch: number,
    from: Temporal.Instant,
    upTo: SealKey,
    limit: number,
    after?: SealKey,
  ): Promise<AuditRowRecord[]> {
    const rows = await auditTx(market).auditLog.findMany({
      where: {
        marketId: market.marketId,
        AND: [
          { occurredAt: IN_RANGE },
          { occurredAt: { gte: dateOf(from) } },
          ...atOrBelow(upTo),
          ...(after === undefined ? [] : above(after)),
        ],
        // The anti-join of DP 11.8: Prisma plans it as a correlated NOT EXISTS.
        seals: { none: { epoch } },
      },
      orderBy: ROW_ORDER,
      take: limit,
    });
    return rows.map(rowOf);
  }

  async insertSeals(market: MarketContext, seals: readonly SealRecord[]): Promise<void> {
    try {
      await auditTx(market).auditLogSeal.createMany({
        data: seals.map((seal) => ({
          marketId: market.marketId,
          tenantId: market.tenantId,
          epoch: seal.epoch,
          chainSeq: seal.chainSeq,
          auditLogId: seal.auditLogId,
          auditOccurredAt: dateOf(seal.auditOccurredAt),
          rowHash: bytes(seal.rowHash),
          chainHash: bytes(seal.chainHash),
          late: seal.late,
          hashVersion: seal.hashVersion,
          sealedAt: dateOf(seal.sealedAt),
        })),
      });
    } catch (error) {
      throw conflictOf(error) ?? error;
    }
  }

  async sealsOfRows(
    market: MarketContext,
    epoch: number,
    keys: readonly SealKey[],
  ): Promise<SealRecord[]> {
    if (keys.length === 0) return [];
    const sorted = [...keys].sort(compareKeys);
    const rows = await auditTx(market).auditLogSeal.findMany({
      where: {
        marketId: market.marketId,
        epoch,
        // A range on the unique key's time column, so its index finds them (Mojtaba C2).
        AND: [
          {
            auditOccurredAt: {
              gte: dateOf(sorted[0]!.occurredAt),
              lte: dateOf(sorted[sorted.length - 1]!.occurredAt),
            },
          },
          { sealedAt: IN_RANGE },
        ],
        auditLogId: { in: sorted.map((key) => key.auditLogId) },
      },
      orderBy: { chainSeq: 'asc' },
    });
    return rows.map(sealOf);
  }

  async latestCheckpoint(
    market: MarketContext,
    epoch: number,
    atOrBelowSeq?: bigint,
  ): Promise<CheckpointRecord | null> {
    const row = await auditTx(market).auditChainCheckpoint.findFirst({
      where: {
        marketId: market.marketId,
        epoch,
        createdAt: IN_RANGE,
        ...(atOrBelowSeq === undefined ? {} : { chainSeq: { lte: atOrBelowSeq } }),
      },
      orderBy: { chainSeq: 'desc' },
    });
    return row === null ? null : checkpointOf(row);
  }

  async insertCheckpoint(market: MarketContext, checkpoint: CheckpointRecord): Promise<void> {
    try {
      await auditTx(market).auditChainCheckpoint.create({
        data: {
          marketId: market.marketId,
          tenantId: market.tenantId,
          epoch: checkpoint.epoch,
          chainSeq: checkpoint.chainSeq,
          chainHash: bytes(checkpoint.chainHash),
          hashVersion: checkpoint.hashVersion,
          createdAt: dateOf(checkpoint.createdAt),
        },
      });
    } catch (error) {
      // Mojtaba L2: the position of a head this unit just sealed already has a checkpoint.
      const reduced = reduceDatabaseError(error);
      if (reduced?.sqlState === UNIQUE_VIOLATION && reduced.constraint === CHECKPOINT_PRIMARY_KEY) {
        throw new CheckpointConflictError();
      }
      throw error;
    }
  }

  async sealsBetween(
    market: MarketContext,
    epoch: number,
    fromSeq: bigint,
    toSeq: bigint,
    limit: number,
  ): Promise<SealWithRow[]> {
    const seals = (
      await auditTx(market).auditLogSeal.findMany({
        where: {
          marketId: market.marketId,
          epoch,
          chainSeq: { gte: fromSeq, lte: toSeq },
          ...SEAL_TIMES,
        },
        orderBy: { chainSeq: 'asc' },
        take: limit,
      })
    ).map(sealOf);
    if (seals.length === 0) return [];
    // The rows by (market_id, id) on audit_log_pkey, without the relation: a row that is gone
    // is a finding (audit.row.missing), never a crash (Mohammad E1).
    const rows = await auditTx(market).auditLog.findMany({
      where: {
        marketId: market.marketId,
        id: { in: seals.map((seal) => seal.auditLogId) },
        occurredAt: IN_RANGE,
      },
    });
    const byId = new Map(rows.map((row) => [row.id, rowOf(row)]));
    return seals.map((seal) => ({ seal, row: byId.get(seal.auditLogId) ?? null }));
  }

  async checkpointsBetween(
    market: MarketContext,
    epoch: number,
    fromSeq: bigint,
    toSeq: bigint,
  ): Promise<CheckpointRecord[]> {
    const rows = await auditTx(market).auditChainCheckpoint.findMany({
      where: {
        marketId: market.marketId,
        epoch,
        chainSeq: { gte: fromSeq, lte: toSeq },
        createdAt: IN_RANGE,
      },
      orderBy: { chainSeq: 'asc' },
    });
    return rows.map(checkpointOf);
  }

  async sealsAboveEpoch(
    market: MarketContext,
    maxKnown: number,
    limit: number,
  ): Promise<SealRecord[]> {
    // A range on the primary key, not NOT IN (Mojtaba C1).
    const rows = await auditTx(market).auditLogSeal.findMany({
      where: { marketId: market.marketId, epoch: { gt: maxKnown }, ...SEAL_TIMES },
      orderBy: [{ epoch: 'asc' }, { chainSeq: 'asc' }],
      take: limit,
    });
    return rows.map(sealOf);
  }

  async rowsAfter(
    market: MarketContext,
    after: Temporal.Instant,
    limit: number,
  ): Promise<AuditRowRecord[]> {
    const rows = await auditTx(market).auditLog.findMany({
      where: {
        marketId: market.marketId,
        AND: [{ occurredAt: { gt: dateOf(after) } }, { occurredAt: IN_RANGE }],
      },
      orderBy: ROW_ORDER,
      take: limit,
    });
    return rows.map(rowOf);
  }

  async earliestRowTime(market: MarketContext): Promise<Temporal.Instant | null> {
    const row = await auditTx(market).auditLog.findFirst({
      where: { marketId: market.marketId, occurredAt: IN_RANGE },
      orderBy: ROW_ORDER,
      select: { occurredAt: true },
    });
    return row === null ? null : instantOf(row.occurredAt);
  }

  async nextRowTime(
    market: MarketContext,
    atOrAfter: Temporal.Instant,
  ): Promise<Temporal.Instant | null> {
    const row = await auditTx(market).auditLog.findFirst({
      where: {
        marketId: market.marketId,
        AND: [{ occurredAt: { gte: dateOf(atOrAfter) } }, { occurredAt: IN_RANGE }],
      },
      orderBy: ROW_ORDER,
      select: { occurredAt: true },
    });
    return row === null ? null : instantOf(row.occurredAt);
  }

  async rowsOutOfRange(market: MarketContext, limit: number): Promise<string[]> {
    const rows = await auditTx(market).auditLog.findMany({
      where: {
        marketId: market.marketId,
        OR: [{ occurredAt: { lt: MIN_TIME } }, { occurredAt: { gte: UNTIL_TIME } }],
      },
      orderBy: { id: 'asc' },
      take: limit,
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  async sealsOutOfRange(
    market: MarketContext,
    limit: number,
    scope: OutOfRangeSealScope,
  ): Promise<SealPosition[]> {
    const outOfRange = {
      OR: [
        { sealedAt: { lt: MIN_TIME } },
        { sealedAt: { gte: UNTIL_TIME } },
        { auditOccurredAt: { lt: MIN_TIME } },
        { auditOccurredAt: { gte: UNTIL_TIME } },
      ],
    };
    // An incremental run reads the primary key from its walk's start up, with no upper bound,
    // plus the unknown epochs; a full run reads the Market's seals (Mojtaba D1).
    const within =
      scope.mode === 'full'
        ? []
        : [
            {
              OR: [
                { epoch: { gt: scope.maxKnownEpoch } },
                { epoch: scope.epoch, chainSeq: { gte: scope.fromSeq } },
              ],
            },
          ];
    return auditTx(market).auditLogSeal.findMany({
      where: { marketId: market.marketId, AND: [outOfRange, ...within] },
      orderBy: [{ epoch: 'asc' }, { chainSeq: 'asc' }],
      take: limit,
      select: { epoch: true, chainSeq: true, auditLogId: true },
    });
  }

  async checkpointsOutOfRange(
    market: MarketContext,
    limit: number,
  ): Promise<{ epoch: number; chainSeq: bigint }[]> {
    return auditTx(market).auditChainCheckpoint.findMany({
      where: {
        marketId: market.marketId,
        OR: [{ createdAt: { lt: MIN_TIME } }, { createdAt: { gte: UNTIL_TIME } }],
      },
      orderBy: [{ epoch: 'asc' }, { chainSeq: 'asc' }],
      take: limit,
      select: { epoch: true, chainSeq: true },
    });
  }
}

/**
 * Tells a lost race from a re-selected row by the constraint, never by guessing (PA 7.1
 * "Duplicates"; DP 11.8): `23505` on the primary key, `55P03` and `40P01` mean another sealer
 * won; `23505` on the unique key means a selected row is already sealed in this epoch. Any
 * other error is not a conflict (null) and is rethrown as it is.
 */
export function conflictOf(error: unknown): SealInsertConflictError | null {
  const conflict = classifyConflict(error);
  if (conflict !== null) return new SealInsertConflictError('position-taken');
  const reduced = reduceDatabaseError(error);
  if (reduced?.sqlState !== UNIQUE_VIOLATION) return null;
  if (reduced.constraint === SEAL_PRIMARY_KEY) return new SealInsertConflictError('position-taken');
  if (reduced.constraint === SEAL_ROW_KEY) return new SealInsertConflictError('row-sealed');
  return null;
}
