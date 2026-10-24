import { Logger } from '@nestjs/common';
import { ok, Temporal } from '@mondapac-drive/shared-kernel';
import type { CallContext, Clock, MarketContext, Result } from '@mondapac-drive/shared-kernel';
import type { UnitOfWork } from '../unit-of-work/unit-of-work';
import { logAuditAlert, type AuditAlertCode } from './audit-alerts';
import {
  CURRENT_EPOCH,
  KNOWN_EPOCHS,
  LATE_SCAN_WINDOW,
  MAX_FINDINGS_PER_CODE,
  SETTLE_WINDOW,
  UNSEALED_SLICE,
  VERIFY_BATCH_SIZE,
  VERIFY_RUN_BUDGET_MS,
} from './audit-chain-policy';
import {
  compareKeys,
  keyOf,
  type AuditChainStore,
  type CheckpointRecord,
  type SealKey,
  type SealRecord,
} from './audit-chain-store';
import {
  chainHashOf,
  chainHashText,
  genesisPrev,
  hashAuditRow,
  KNOWN_HASH_VERSIONS,
  sameHash,
} from './audit-hash';
import type { AnchorSource, StoredAnchor } from './anchor-sink';

/** The far end of the uuid order: a key above every id at one instant. */
const MAX_UUID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

/** `full` from the start of the chain; `incremental` from the last checkpoint (PA 8). */
export type VerifyMode = 'full' | 'incremental';

/** One finding: a fixed code and a position, never row content (PA 8). */
export interface AuditFinding {
  readonly code: AuditAlertCode;
  readonly marketId: string;
  readonly epoch: number | null;
  readonly chainSeq: bigint | null;
  readonly auditLogId: string | null;
}

/** What one verification of one Market found. */
export interface VerifyReport {
  readonly marketId: string;
  readonly mode: VerifyMode;
  /** The head read once at the start; nothing past it was verified (Hassan L1). */
  readonly pinnedHead: bigint | null;
  /** The first `chain_seq` the walk verified (1 for a full run). */
  readonly fromSeq: bigint | null;
  readonly sealsChecked: number;
  /** Late seals met on the walk, each also an info line `audit.verify.late-seal` (Hassan L3). */
  readonly lateSeals: number;
  /** The findings listed: at most {@link MAX_FINDINGS_PER_CODE} of each code. */
  readonly findings: readonly AuditFinding[];
  /** Every finding counted per code, the ones not listed included (Mohammad 3, Hassan L2). */
  readonly findingTotals: Readonly<Partial<Record<AuditAlertCode, number>>>;
  /** Codes whose total is a lower bound: their read stopped at its limit. */
  readonly totalsAtLeast: readonly AuditAlertCode[];
  /** False when the run budget ran out (`audit.verify.incomplete`); the rest was not checked. */
  readonly complete: boolean;
}

/** The state of the walk along one epoch's chain. */
interface Walk {
  /** The chain hash the next link must build on; null after a gap until re-synchronised. */
  prev: Uint8Array | null;
  expectedSeq: bigint;
  hashVersion: number;
  lastNonLate: SealKey | null;
}

type Find = (
  code: AuditAlertCode,
  chainSeq: bigint | null,
  auditLogId: string | null,
  findingEpoch?: number | null,
) => void;

/**
 * The verifier of docs/design/domain/platform-audit.md 8 (`platform.audit-verify`, and the
 * operator command `audit-verify`). It reads only, as the system actor, in read-only units
 * (ADR-0025) and in batches; it is logged, not audited. It never trusts a stored hash: every
 * `row_hash` and `chain_hash` is recomputed from the rows read back.
 *
 * - **Pinned head** (Hassan L1): the anchors are read first, then the head of the current
 *   epoch, once; the walk stops at that head however the chain grows meanwhile.
 * - (a) `chain_seq` runs 1..head with no gap (`audit.chain.gap`); a seal in an epoch the
 *   verifier does not know is `audit.seal.unknown-epoch` (F12).
 * - (b) every link recomputes from its predecessor (`audit.chain.broken`). After a finding the
 *   walk re-synchronises on the stored chain hash, so a break is reported where it is and the
 *   later links are still checked (a changed `chain_hash` breaks its own link and the next).
 * - (c) every `row_hash` matches its row as read (`audit.row.mismatch`); the fallback form is
 *   chosen only by whether `canonicalJson` refuses the row (Hassan N1 c), so a row that
 *   canonicalises but carries a fallback-style hash is a mismatch.
 * - (d) every row at or below `min(watermark, now - S)` has a seal in the epoch
 *   (`audit.row.unsealed`), in one-day slices that skip empty days; a seal whose row is gone is
 *   `audit.row.missing` (rows are read by id, Mohammad E1). A watermark later than `now - S`
 *   is `audit.seal.watermark-future` here too (Hassan M3).
 * - (e) every checkpoint matches the chain at its `chain_seq` (`audit.checkpoint.mismatch`).
 * - (f) with a bound `AnchorSource`: the head is at or past every anchor, the chain hash at
 *   each anchor equals it, and every version of an anchor key is identical
 *   (`audit.anchor.mismatch`).
 * - (g) `audit_occurred_at` equals the row's `occurred_at` (`audit.seal.time-mismatch`).
 * - (h) non-late seals strictly ascend in `(occurred_at, id)`, and every late seal lies below
 *   the non-late seal before it (`audit.seal.out-of-order`); every late seal is reported each
 *   run as an info line (Hassan L3).
 * - (i) `hash_version` is known and never goes down (`audit.seal.hash-version`).
 * - (j) no row is later than `now + S` (`audit.row.future`); no time column of the chain
 *   tables is outside AUDIT_TIME_RANGE (`audit.row.out-of-range`, `audit.seal.out-of-range`,
 *   `audit.checkpoint.out-of-range`; Hassan M1).
 * - (k) numbers in `before` and `after` are safe integers (`audit.row.noncanonical`, also for
 *   every row hashed with the fallback).
 *
 * Each finding is one error-level line marked for alerting; it changes nothing. At most
 * {@link MAX_FINDINGS_PER_CODE} lines per code, then one line with the number suppressed; the
 * report counts them all. Past its budget the run stops with `audit.verify.incomplete`.
 */
export class AuditVerifier {
  private readonly logger = new Logger('AuditVerifier');

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly store: AuditChainStore,
    private readonly clock: Clock,
    private readonly anchorSource: AnchorSource | null = null,
  ) {}

  async verify(context: CallContext, mode: VerifyMode): Promise<VerifyReport> {
    const market = context.market;
    const marketId = market.marketId;
    const epoch = CURRENT_EPOCH;
    const deadline = this.clock.now().add({ milliseconds: VERIFY_RUN_BUDGET_MS });
    const overBudget = () => Temporal.Instant.compare(this.clock.now(), deadline) >= 0;
    const findings: AuditFinding[] = [];
    const totals = new Map<AuditAlertCode, number>();
    const atLeast = new Set<AuditAlertCode>();
    const find: Find = (code, chainSeq, auditLogId, findingEpoch = epoch) => {
      const count = (totals.get(code) ?? 0) + 1;
      totals.set(code, count);
      if (count > MAX_FINDINGS_PER_CODE) return;
      const finding = { code, marketId, epoch: findingEpoch, chainSeq, auditLogId };
      findings.push(finding);
      logAuditAlert(this.logger, code, finding);
    };
    /** Reports a bounded read's results; a full read means the total is a lower bound. */
    const findAll = <T>(code: AuditAlertCode, items: readonly T[], each: (item: T) => void) => {
      for (const item of items) each(item);
      if (items.length >= MAX_FINDINGS_PER_CODE) atLeast.add(code);
    };
    let complete = true;
    let lateSeals = 0;

    // The anchors first, then the head: an anchor is written only after its seal committed,
    // so every anchor read before the head is at or below it unless the tail was cut.
    const anchors =
      this.anchorSource === null ? null : await this.anchorSource.anchors(marketId, epoch);
    const now = this.clock.now();
    const settledUntil = now.subtract(SETTLE_WINDOW);
    const pinned = await this.read(market, async () => {
      const [head] = await this.store.lastSeals(market, epoch, 1);
      return head ?? null;
    });
    const watermark = await this.read(market, () => this.store.watermark(market, epoch));

    // (a) Seals of an epoch nobody opened.
    const foreign = await this.read(market, () =>
      this.store.sealsAboveEpoch(market, Math.max(...KNOWN_EPOCHS), MAX_FINDINGS_PER_CODE),
    );
    findAll('audit.seal.unknown-epoch', foreign, (seal) =>
      find('audit.seal.unknown-epoch', seal.chainSeq, seal.auditLogId, seal.epoch),
    );

    // A watermark the sealer would stop at (PA 7.1 step 2): (d) never looks above now - S.
    if (watermark !== null && Temporal.Instant.compare(watermark.occurredAt, settledUntil) > 0) {
      find('audit.seal.watermark-future', watermark.chainSeq, watermark.auditLogId);
    }

    // The starting point of the walk.
    const walk: Walk = {
      prev: genesisPrev(),
      expectedSeq: 1n,
      hashVersion: 0,
      lastNonLate: null,
    };
    let fromSeq: bigint | null = pinned === null ? null : 1n;
    let start: SealRecord | null = null;
    if (mode === 'incremental' && pinned !== null) {
      const checkpoint = await this.read(market, () =>
        this.store.latestCheckpoint(market, epoch, pinned.chainSeq),
      );
      if (checkpoint !== null) {
        const [seal] = await this.read(market, () =>
          this.store.sealsBetween(market, epoch, checkpoint.chainSeq, checkpoint.chainSeq, 1),
        );
        if (seal === undefined) {
          find('audit.chain.gap', checkpoint.chainSeq, null);
        } else if (
          !sameHash(seal.seal.chainHash, checkpoint.chainHash) ||
          seal.seal.hashVersion !== checkpoint.hashVersion
        ) {
          find('audit.checkpoint.mismatch', checkpoint.chainSeq, seal.seal.auditLogId);
        } else {
          start = seal.seal;
        }
        if (start !== null) {
          walk.prev = checkpoint.chainHash;
          walk.expectedSeq = checkpoint.chainSeq + 1n;
          walk.hashVersion = start.hashVersion;
          walk.lastNonLate = start.late ? null : keyOfSeal(start);
          fromSeq = walk.expectedSeq;
        }
      }
    }

    // (b), (c), (e), (f) at each seal, (g), (h), (i), (k), up to the pinned head.
    const anchorsBySeq = new Map<bigint, StoredAnchor>();
    if (anchors !== null) {
      for (const anchor of anchors) {
        anchorsBySeq.set(anchor.chainSeq, anchor);
        if (new Set(anchor.versions).size > 1) find('audit.anchor.mismatch', anchor.chainSeq, null);
        // A cut tail, or a chain recomputed below an anchor: the head is below the anchor.
        if (pinned === null || anchor.chainSeq > pinned.chainSeq) {
          find('audit.anchor.mismatch', anchor.chainSeq, null);
        }
      }
    }
    let sealsChecked = 0;
    /** The highest `chain_seq` the walk covered; checkpoints and anchors above it were not. */
    let walkedTo = walk.expectedSeq - 1n;
    if (pinned !== null && walk.expectedSeq <= pinned.chainSeq) {
      const checkpoints = new Map<bigint, CheckpointRecord>();
      for (const checkpoint of await this.read(market, () =>
        this.store.checkpointsBetween(market, epoch, walk.expectedSeq, pinned.chainSeq),
      )) {
        checkpoints.set(checkpoint.chainSeq, checkpoint);
      }
      let next = walk.expectedSeq;
      while (next <= pinned.chainSeq) {
        if (overBudget()) {
          complete = false;
          break;
        }
        const to =
          next + BigInt(VERIFY_BATCH_SIZE) - 1n < pinned.chainSeq
            ? next + BigInt(VERIFY_BATCH_SIZE) - 1n
            : pinned.chainSeq;
        const batch = await this.read(market, () =>
          this.store.sealsBetween(market, epoch, next, to, VERIFY_BATCH_SIZE),
        );
        for (const { seal, row } of batch) {
          if (seal.chainSeq > walk.expectedSeq) {
            find('audit.chain.gap', walk.expectedSeq, null);
            walk.prev = null;
          }
          walk.expectedSeq = seal.chainSeq + 1n;
          sealsChecked += 1;

          // (i) a known version, never going down.
          if (
            !KNOWN_HASH_VERSIONS.includes(seal.hashVersion) ||
            seal.hashVersion < walk.hashVersion
          ) {
            find('audit.seal.hash-version', seal.chainSeq, seal.auditLogId);
          }
          walk.hashVersion = Math.max(walk.hashVersion, seal.hashVersion);

          // (c), (g), (k): the row as read back.
          let rowHash = seal.rowHash;
          let rowMismatch = false;
          if (row === null) {
            find('audit.row.missing', seal.chainSeq, seal.auditLogId);
          } else {
            if (row.occurredAt.epochNanoseconds !== seal.auditOccurredAt.epochNanoseconds) {
              find('audit.seal.time-mismatch', seal.chainSeq, seal.auditLogId);
            }
            const recomputed = hashAuditRow(row);
            rowHash = recomputed.hash;
            if (!sameHash(recomputed.hash, seal.rowHash)) {
              rowMismatch = true;
              find('audit.row.mismatch', seal.chainSeq, seal.auditLogId);
            }
            if (!recomputed.canonical) {
              find('audit.row.noncanonical', seal.chainSeq, seal.auditLogId);
            }
          }

          // (b) the link, from the predecessor's chain hash and the recomputed row hash.
          let expected: Uint8Array | null = null;
          const prev = walk.prev;
          if (prev !== null) {
            expected = this.link(seal, prev, rowHash);
            if (expected === null || !sameHash(expected, seal.chainHash)) {
              // A row already reported as edited is not reported twice when its stored row
              // hash still links: the stored chain is intact, the row is not.
              const viaStored = rowMismatch ? this.link(seal, prev, seal.rowHash) : null;
              const storedLinks = viaStored !== null && sameHash(viaStored, seal.chainHash);
              if (!storedLinks) find('audit.chain.broken', seal.chainSeq, seal.auditLogId);
            }
          }
          if (seal.chainSeq === 1n && seal.late) {
            find('audit.chain.broken', seal.chainSeq, seal.auditLogId);
          }
          // Re-synchronise on the stored hash, so a break is reported where it is.
          walk.prev = seal.chainHash;

          // (h) non-late seals strictly ascend in (occurred_at, id); a late seal lies below the
          // non-late seal before it, since the sealer seals late rows below its watermark.
          const key = keyOfSeal(seal);
          if (seal.late) {
            lateSeals += 1;
            if (lateSeals <= MAX_FINDINGS_PER_CODE) {
              this.logger.log({
                msg: 'audit.verify.late-seal',
                marketId,
                epoch: seal.epoch,
                chainSeq: String(seal.chainSeq),
                auditLogId: seal.auditLogId,
              });
            }
            if (walk.lastNonLate !== null && compareKeys(key, walk.lastNonLate) >= 0) {
              find('audit.seal.out-of-order', seal.chainSeq, seal.auditLogId);
            }
          } else {
            if (walk.lastNonLate !== null && compareKeys(key, walk.lastNonLate) <= 0) {
              find('audit.seal.out-of-order', seal.chainSeq, seal.auditLogId);
            }
            walk.lastNonLate = key;
          }

          // (e) and (f): what the chain says at this position, recomputed when it links.
          const atSeq = expected !== null && sameHash(expected, seal.chainHash) ? expected : null;
          const checkpoint = checkpoints.get(seal.chainSeq);
          if (
            checkpoint !== undefined &&
            (atSeq === null ||
              !sameHash(checkpoint.chainHash, atSeq) ||
              checkpoint.hashVersion !== seal.hashVersion)
          ) {
            find('audit.checkpoint.mismatch', seal.chainSeq, seal.auditLogId);
          }
          checkpoints.delete(seal.chainSeq);
          // Differing versions of one key were reported above; here the first is compared.
          const anchor = anchorsBySeq.get(seal.chainSeq);
          if (
            anchor !== undefined &&
            (atSeq === null || anchor.versions[0] !== chainHashText(atSeq))
          ) {
            find('audit.anchor.mismatch', seal.chainSeq, seal.auditLogId);
          }
          anchorsBySeq.delete(seal.chainSeq);
        }
        if (walk.expectedSeq <= to) {
          // The range ended early: the seals up to `to` are missing.
          find('audit.chain.gap', walk.expectedSeq, null);
          walk.prev = null;
          walk.expectedSeq = to + 1n;
        }
        walkedTo = to;
        next = to + 1n;
      }
      // Checkpoints at walked positions with no seal (a gap) do not match the chain.
      for (const checkpoint of checkpoints.values()) {
        if (checkpoint.chainSeq <= walkedTo) {
          find('audit.checkpoint.mismatch', checkpoint.chainSeq, null);
        }
      }
    }
    for (const anchor of anchorsBySeq.values()) {
      const below = fromSeq === null || anchor.chainSeq < fromSeq;
      const beyond = pinned === null || anchor.chainSeq > pinned.chainSeq;
      const unwalked = anchor.chainSeq > walkedTo;
      // Below the walk (an incremental run) is the full run's to check; beyond was reported.
      if (!below && !beyond && !unwalked) find('audit.anchor.mismatch', anchor.chainSeq, null);
    }

    // (d) every settled row at or below the watermark has a seal in this epoch.
    if (complete && watermark !== null) {
      const upTo: SealKey =
        Temporal.Instant.compare(watermark.occurredAt, settledUntil) <= 0
          ? watermark
          : { occurredAt: settledUntil, auditLogId: MAX_UUID };
      complete = await this.unsealed(market, mode, start, upTo, find, overBudget);
    }

    // (j) no row later than now + S, and no time out of range: (d) would never judge them.
    const future = await this.read(market, () =>
      this.store.rowsAfter(market, now.add(SETTLE_WINDOW), MAX_FINDINGS_PER_CODE),
    );
    findAll('audit.row.future', future, (row) => find('audit.row.future', null, row.id, null));
    const rowsOut = await this.read(market, () =>
      this.store.rowsOutOfRange(market, MAX_FINDINGS_PER_CODE),
    );
    findAll('audit.row.out-of-range', rowsOut, (id) =>
      find('audit.row.out-of-range', null, id, null),
    );
    // An incremental run looks from its walk's start up and in the unknown epochs (Mojtaba D1).
    const sealsOut = await this.read(market, () =>
      this.store.sealsOutOfRange(
        market,
        MAX_FINDINGS_PER_CODE,
        mode === 'full'
          ? { mode }
          : { mode, epoch, fromSeq: fromSeq ?? 1n, maxKnownEpoch: Math.max(...KNOWN_EPOCHS) },
      ),
    );
    findAll('audit.seal.out-of-range', sealsOut, (seal) =>
      find('audit.seal.out-of-range', seal.chainSeq, seal.auditLogId, seal.epoch),
    );
    const checkpointsOut = await this.read(market, () =>
      this.store.checkpointsOutOfRange(market, MAX_FINDINGS_PER_CODE),
    );
    findAll('audit.checkpoint.out-of-range', checkpointsOut, (checkpoint) =>
      find('audit.checkpoint.out-of-range', checkpoint.chainSeq, null, checkpoint.epoch),
    );

    // One line per code whose findings were not all listed.
    for (const [code, total] of totals) {
      if (total > MAX_FINDINGS_PER_CODE) {
        logAuditAlert(
          this.logger,
          code,
          { marketId, epoch },
          {
            suppressed: total - MAX_FINDINGS_PER_CODE,
          },
        );
      }
    }
    if (!complete) {
      logAuditAlert(this.logger, 'audit.verify.incomplete', {
        marketId,
        epoch,
        chainSeq: walkedTo > 0n ? walkedTo : null,
      });
    }

    const findingTotals = Object.fromEntries(totals) as Partial<Record<AuditAlertCode, number>>;
    const report: VerifyReport = {
      marketId,
      mode,
      pinnedHead: pinned?.chainSeq ?? null,
      fromSeq,
      sealsChecked,
      lateSeals,
      findings,
      findingTotals,
      totalsAtLeast: [...atLeast],
      complete,
    };
    this.logger.log({
      msg: 'audit.verify.done',
      marketId,
      mode,
      pinnedHead: report.pinnedHead === null ? null : String(report.pinnedHead),
      sealsChecked,
      lateSeals,
      findings: findings.length,
      findingTotals,
      totalsAtLeast: report.totalsAtLeast,
      complete,
      correlationId: context.correlationId,
    });
    return report;
  }

  /** The chain hash a seal must carry on `prev` with `rowHash`; null for an unusable seal. */
  private link(seal: SealRecord, prev: Uint8Array, rowHash: Uint8Array): Uint8Array | null {
    try {
      return chainHashOf({
        hashVersion: seal.hashVersion,
        epoch: seal.epoch,
        prev,
        chainSeq: seal.chainSeq,
        late: seal.late,
        rowHash,
      });
    } catch {
      return null;
    }
  }

  /**
   * Check (d), in one-day slices up to `upTo`: from the oldest row (full), or from
   * `LATE_SCAN_WINDOW` below the start checkpoint's seal (incremental), so a row the late-row
   * scan could still seal is judged (Mohammad 5). After each slice the next starts at the
   * next row's day, so empty days cost nothing (Hassan M3). False when the budget ran out.
   */
  private async unsealed(
    market: MarketContext,
    mode: VerifyMode,
    start: SealRecord | null,
    upTo: SealKey,
    find: Find,
    overBudget: () => boolean,
  ): Promise<boolean> {
    let from: Temporal.Instant | null;
    if (mode === 'incremental' && start !== null) {
      from = start.auditOccurredAt.subtract(LATE_SCAN_WINDOW);
    } else {
      from = await this.read(market, () => this.store.earliestRowTime(market));
    }
    while (from !== null && Temporal.Instant.compare(from, upTo.occurredAt) <= 0) {
      if (overBudget()) return false;
      const sliceEnd = from.add(UNSEALED_SLICE);
      const sliceUpTo: SealKey =
        Temporal.Instant.compare(sliceEnd, upTo.occurredAt) > 0
          ? upTo
          : // The slice's end, just before the next slice's first instant.
            { occurredAt: sliceEnd.subtract({ milliseconds: 1 }), auditLogId: MAX_UUID };
      const sliceFrom = from;
      let after: SealKey | undefined;
      for (;;) {
        const rows = await this.read(market, () =>
          this.store.unsealedRows(
            market,
            CURRENT_EPOCH,
            sliceFrom,
            sliceUpTo,
            VERIFY_BATCH_SIZE,
            after,
          ),
        );
        for (const row of rows) find('audit.row.unsealed', null, row.id);
        if (rows.length < VERIFY_BATCH_SIZE) break;
        after = keyOf(rows[rows.length - 1]!);
      }
      // The next slice starts at the next row at or after this slice's end.
      from = await this.read(market, () => this.store.nextRowTime(market, sliceEnd));
    }
    return true;
  }

  /** One read-only unit (ADR-0025): no transaction, never retried. */
  private async read<T>(market: MarketContext, work: () => Promise<T>): Promise<T> {
    const result: Result<T, never> = await this.unitOfWork.run(
      market,
      async () => ok(await work()),
      { readOnly: true },
    );
    if (!result.ok) throw new Error('AuditVerifier: a read unit returned err');
    return result.value;
  }
}

function keyOfSeal(seal: SealRecord): SealKey {
  return { occurredAt: seal.auditOccurredAt, auditLogId: seal.auditLogId };
}
