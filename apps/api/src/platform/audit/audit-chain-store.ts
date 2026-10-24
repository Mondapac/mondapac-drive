import type { MarketContext, Temporal } from '@mondapac-drive/shared-kernel';
import type { AuditRowRecord } from './audit-hash';

/**
 * What the sealer and the verifier read and write of the chain tables
 * (docs/design/domain/platform-audit.md 7 and 8; docs/design/data/platform.md 11.7 and 11.8).
 * Implemented in `platform/persistence/audit/` over the open unit's audit models (`auditTx`),
 * so every statement passes the market guard. Every method runs in the caller's open unit:
 * the sealer's read-write unit, or the verifier's read-only unit (ADR-0025). Bound only by
 * `AuditModule`; never exported, so no module reads the chain (PA 2).
 */
/**
 * Where the verifier looks for seals with a time outside the range (Mojtaba D1). A full run
 * looks at every seal of the Market. An incremental run looks at `epoch` from `fromSeq` up,
 * with no upper bound (a seal at head + 1 with such a time is invisible to the head read and
 * only this read names it), and at every epoch above `maxKnownEpoch` (`sealsAboveEpoch` is
 * bounded to the range too), so it reads only the part of the table its walk reads.
 */
export type OutOfRangeSealScope =
  | { readonly mode: 'full' }
  | {
      readonly mode: 'incremental';
      readonly epoch: number;
      readonly fromSeq: bigint;
      readonly maxKnownEpoch: number;
    };

export interface AuditChainStore {
  // Every read returns only rows whose time columns lie in AUDIT_TIME_RANGE (audit-chain-policy):
  // a value outside cannot be held by a JavaScript Date. The `...OutOfRange` reads name those
  // rows by id for the verifier (Hassan M1; Mojtaba's sign-off).

  /** The seals of `epoch` with the highest `chain_seq`, newest first, at most `count` (11.7). */
  lastSeals(market: MarketContext, epoch: number, count: number): Promise<SealRecord[]>;

  /**
   * The greatest `(audit_occurred_at, audit_log_id)` sealed in `epoch`, from the seal's unique
   * key, never derived from the head (PA 7.1 step 2; Hassan M1, Mojtaba F1). Null: no seal.
   */
  watermark(market: MarketContext, epoch: number): Promise<Watermark | null>;

  /**
   * Up to `limit` audit rows of the Market above `after` (all rows when null) with
   * `occurred_at <= settledUntil`, in `(occurred_at, id)` order: the keyset of DP 11.8.
   */
  rowsAbove(
    market: MarketContext,
    after: SealKey | null,
    settledUntil: Temporal.Instant,
    limit: number,
  ): Promise<AuditRowRecord[]>;

  /**
   * Up to `limit` audit rows with `occurred_at` from `from` up to the key `upTo` (inclusive)
   * that have no seal in `epoch` (the anti-join of DP 11.8), in `(occurred_at, id)` order: the
   * late-row scan of PA 7.1 step 4 and check (d) of PA 8. With `after`, only rows above that
   * key: the next page.
   */
  unsealedRows(
    market: MarketContext,
    epoch: number,
    from: Temporal.Instant,
    upTo: SealKey,
    limit: number,
    after?: SealKey,
  ): Promise<AuditRowRecord[]>;

  /** Inserts the seals in one statement. Throws {@link SealInsertConflictError} on a conflict. */
  insertSeals(market: MarketContext, seals: readonly SealRecord[]): Promise<void>;

  /**
   * The seals of `epoch` of the audit rows at the given keys (the duplicate-row log, PA 7.1),
   * read through the seal's unique key within the keys' time range (Mojtaba C2).
   */
  sealsOfRows(
    market: MarketContext,
    epoch: number,
    keys: readonly SealKey[],
  ): Promise<SealRecord[]>;

  /**
   * The checkpoint of `epoch` with the highest `chain_seq`, at or below `atOrBelow` when given,
   * or null (DP 11.8).
   */
  latestCheckpoint(
    market: MarketContext,
    epoch: number,
    atOrBelow?: bigint,
  ): Promise<CheckpointRecord | null>;

  /** Inserts a checkpoint. Throws {@link CheckpointConflictError} when its position is taken. */
  insertCheckpoint(market: MarketContext, checkpoint: CheckpointRecord): Promise<void>;

  /**
   * The seals of `epoch` with `chain_seq` from `fromSeq` to `toSeq`, ascending, each with its
   * audit row read by `(market_id, id)`: null when the row is gone or its time is out of range
   * (Mohammad E1; the seal is read without the relation, so a missing row is a finding).
   */
  sealsBetween(
    market: MarketContext,
    epoch: number,
    fromSeq: bigint,
    toSeq: bigint,
    limit: number,
  ): Promise<SealWithRow[]>;

  /** The checkpoints of `epoch` with `chain_seq` from `fromSeq` to `toSeq`, ascending. */
  checkpointsBetween(
    market: MarketContext,
    epoch: number,
    fromSeq: bigint,
    toSeq: bigint,
  ): Promise<CheckpointRecord[]>;

  /**
   * Up to `limit` seals of the Market in an epoch above `maxKnown`, by epoch and `chain_seq`:
   * a range on the primary key (Mojtaba C1). Epochs below 1 the CHECK refuses.
   */
  sealsAboveEpoch(market: MarketContext, maxKnown: number, limit: number): Promise<SealRecord[]>;

  /** Up to `limit` audit rows with `occurred_at` after `after`, oldest first (PA 8 (j)). */
  rowsAfter(
    market: MarketContext,
    after: Temporal.Instant,
    limit: number,
  ): Promise<AuditRowRecord[]>;

  /** The `occurred_at` of the Market's oldest audit row, or null when it has none. */
  earliestRowTime(market: MarketContext): Promise<Temporal.Instant | null>;

  /** The `occurred_at` of the Market's first audit row at or after `atOrAfter`, or null. */
  nextRowTime(market: MarketContext, atOrAfter: Temporal.Instant): Promise<Temporal.Instant | null>;

  /** Up to `limit` ids of audit rows whose `occurred_at` is outside the range. */
  rowsOutOfRange(market: MarketContext, limit: number): Promise<string[]>;

  /**
   * Up to `limit` seals whose `sealed_at` or `audit_occurred_at` is outside the range, within
   * `scope` (Mojtaba D1).
   */
  sealsOutOfRange(
    market: MarketContext,
    limit: number,
    scope: OutOfRangeSealScope,
  ): Promise<SealPosition[]>;

  /** Up to `limit` checkpoints whose `created_at` is outside the range. */
  checkpointsOutOfRange(
    market: MarketContext,
    limit: number,
  ): Promise<{ readonly epoch: number; readonly chainSeq: bigint }[]>;
}

/** Where a seal is, without its times. */
export interface SealPosition {
  readonly epoch: number;
  readonly chainSeq: bigint;
  readonly auditLogId: string;
}

/** Nest token of the {@link AuditChainStore}; bound by `AuditModule` only. */
export const AUDIT_CHAIN_STORE = Symbol('AUDIT_CHAIN_STORE');

/** The position of an audit row in time order: `(occurred_at, id)` (PA 6.1). */
export interface SealKey {
  readonly occurredAt: Temporal.Instant;
  readonly auditLogId: string;
}

/** The watermark and the `chain_seq` of the seal that holds it. */
export interface Watermark extends SealKey {
  readonly chainSeq: bigint;
}

/** One row of `platform.audit_log_seal` (DP 11.3). */
export interface SealRecord {
  readonly epoch: number;
  readonly chainSeq: bigint;
  readonly auditLogId: string;
  readonly auditOccurredAt: Temporal.Instant;
  readonly rowHash: Uint8Array;
  readonly chainHash: Uint8Array;
  readonly late: boolean;
  readonly hashVersion: number;
  readonly sealedAt: Temporal.Instant;
}

/** A seal and its audit row; `row` is null only if the foreign key was bypassed. */
export interface SealWithRow {
  readonly seal: SealRecord;
  readonly row: AuditRowRecord | null;
}

/** One row of `platform.audit_chain_checkpoint` (DP 11.4). */
export interface CheckpointRecord {
  readonly epoch: number;
  readonly chainSeq: bigint;
  readonly chainHash: Uint8Array;
  readonly hashVersion: number;
  readonly createdAt: Temporal.Instant;
}

/**
 * Why an insert of seals failed, told apart by the constraint and SQLSTATE (PA 7.1
 * "Duplicates", 7.2; DP 11.8 "Which duplicate"):
 * - `position-taken`: `23505` on `audit_log_seal_pkey`, or `55P03` or `40P01`: another sealer
 *   won the race;
 * - `row-sealed`: `23505` on `audit_log_seal_market_id_epoch_occurred_at_id_key`: a selected
 *   row is already sealed in this epoch.
 */
export type SealConflict = 'position-taken' | 'row-sealed';

export class SealInsertConflictError extends Error {
  override readonly name = 'SealInsertConflictError';
  constructor(readonly conflict: SealConflict) {
    super(`The seal insert met a conflict: ${conflict}`);
  }
}

/**
 * A checkpoint insert met `23505` on `audit_chain_checkpoint_pkey`: a checkpoint already holds
 * the position of a head this unit just sealed, which only a write past the sealer can cause.
 * An integrity alert, `audit.checkpoint.conflict` (Mojtaba L2).
 */
export class CheckpointConflictError extends Error {
  override readonly name = 'CheckpointConflictError';
  constructor() {
    super('A checkpoint already holds this position');
  }
}

/** Orders two keys as `(occurred_at, id)` does in the database (uuid order is hex order). */
export function compareKeys(a: SealKey, b: SealKey): number {
  const time = a.occurredAt.epochNanoseconds - b.occurredAt.epochNanoseconds;
  if (time !== 0n) return time < 0n ? -1 : 1;
  return a.auditLogId < b.auditLogId ? -1 : a.auditLogId > b.auditLogId ? 1 : 0;
}

/** The key of a row. */
export function keyOf(row: Pick<AuditRowRecord, 'occurredAt' | 'id'>): SealKey {
  return { occurredAt: row.occurredAt, auditLogId: row.id };
}
