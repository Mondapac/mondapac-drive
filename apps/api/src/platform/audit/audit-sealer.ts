import { Logger } from '@nestjs/common';
import { ok, Temporal } from '@mondapac-drive/shared-kernel';
import type { CallContext, Clock, MarketContext } from '@mondapac-drive/shared-kernel';
import { TransactionConflictError } from '../unit-of-work/errors';
import type { UnitOfWork } from '../unit-of-work/unit-of-work';
import { logAuditAlert } from './audit-alerts';
import {
  CHECKPOINT_EVERY,
  CHECKPOINT_ROWS,
  CURRENT_EPOCH,
  HEARTBEAT_EVERY,
  LAG_ALERT_AFTER,
  LATE_SCAN_EVERY,
  LATE_SCAN_WINDOW,
  SEAL_BATCH_SIZE,
  SEAL_JOB_MAX_RUN_MS,
  SETTLE_WINDOW,
  STALL_RUNS,
} from './audit-chain-policy';
import {
  CheckpointConflictError,
  keyOf,
  SealInsertConflictError,
  type AuditChainStore,
  type CheckpointRecord,
  type SealRecord,
  type Watermark,
} from './audit-chain-store';
import {
  AUDIT_HASH_VERSION,
  chainHashOf,
  chainHashText,
  genesisPrev,
  hashAuditRow,
  KNOWN_HASH_VERSIONS,
  sameHash,
  type AuditRowRecord,
} from './audit-hash';
import type { AnchorSink, ChainAnchor } from './anchor-sink';

/** The part of a run's time in which a new batch may still start; the rest is margin. */
const RUN_BUDGET_MS = SEAL_JOB_MAX_RUN_MS - 15_000;

/** The far end of the uuid order: a key above every id at one instant. */
const MAX_UUID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

/** What one run did for one Market. */
export interface SealRun {
  readonly marketId: string;
  /** Seals this run committed. */
  readonly sealed: number;
  /** Of them, sealed `late` (PA 6.1 option A). */
  readonly late: number;
  /** Why the run ended. */
  readonly ended:
    | 'idle'
    | 'time-spent'
    | 'chain-broken'
    | 'watermark-future'
    | 'lost-race'
    | 'duplicate-row'
    | 'checkpoint-conflict';
  /** Whether settled rows were waiting for a seal this run (PA 7.1 step 8). */
  readonly pending: boolean;
  /** Consecutive runs with waiting rows and a head that did not move. */
  readonly stalledRuns: number;
}

/** What the sealer remembers of a Market between runs: in memory, per worker process. */
interface MarketState {
  /** The last late-row scan; null until the first run of this process (F3). */
  lateScanAt: Temporal.Instant | null;
  heartbeatAt: Temporal.Instant | null;
  /** The head seen at the end of the previous run; undefined before the first run. */
  lastHeadSeq: bigint | null | undefined;
  stalledRuns: number;
}

/** What a batch unit read, kept outside it for the conflict path. */
interface BatchSeen {
  head: SealRecord | null;
  selected: readonly AuditRowRecord[];
}

/** One batch's outcome inside its unit. */
type BatchOutcome =
  | { readonly kind: 'broken'; readonly head: SealRecord }
  | {
      readonly kind: 'watermark-future';
      readonly head: SealRecord | null;
      readonly watermark: Watermark;
    }
  | { readonly kind: 'idle'; readonly head: SealRecord | null; readonly scanned: boolean }
  | {
      readonly kind: 'sealed';
      readonly seals: readonly SealRecord[];
      readonly lateCount: number;
      readonly flagged: readonly SealRecord[];
      readonly checkpoint: CheckpointRecord | null;
      readonly scanned: boolean;
      readonly full: boolean;
    };

/**
 * The sealer of docs/design/domain/platform-audit.md 7 (`platform.audit-seal`, worker only).
 * Platform infrastructure like the relay: not a use case, no gate; it runs with the scheduler's
 * system `JobContext`, one hosted Market at a time, and every statement goes through the
 * guarded `tx(market)` of its own units. It writes no audit rows.
 *
 * One run, per Market (PA 7.1):
 * 1. **Head.** Each batch is one read-write unit (READ COMMITTED) that reads the head and its
 *    predecessor of the current epoch (a constant, never read from the seals; F12) and
 *    recomputes the head's link. A broken link stops this Market: `audit.chain.broken`. The
 *    sealer never repairs anything.
 * 2. **Watermark,** the greatest sealed `(occurred_at, id)` of the epoch, from the seal's
 *    unique key, never from the head. One later than `now - S` stops this Market:
 *    `audit.seal.watermark-future` (Hassan N1 a).
 * 3. **Batch:** up to 500 settled rows above the watermark (`occurred_at <= now - S`, `now`
 *    from the Clock), hashed as read back, given `chain_seq` head + 1, ..., inserted together.
 * 4. **Late rows,** on the first run of the process and then at most every 5 minutes: unsealed
 *    rows in `[watermark - 24 h, watermark]`, sealed in the same batch with `late = true`, each
 *    alerting `audit.seal.late-row`.
 * 5. **Checkpoint,** in the unit of a batch that moved the head, when 1 hour or 10 000 seals
 *    passed since the last one (or there is none yet); sent to the `AnchorSink` after commit.
 * 6. **Heartbeat** of the current head to the `AnchorSink` once a day, with no checkpoint row.
 * 7. **Lag:** `audit.seal.lagging` when the oldest settled unsealed row is older than 15 min.
 * 8. **Stalled:** `audit.seal.stalled` when rows wait (on either side of the watermark) and the
 *    head has not moved for 3 consecutive runs.
 *
 * A lost race (`23505` on the primary key, `55P03`, `40P01`) ends the Market's run at info
 * level. A selected row that is already sealed (`23505` on the unique key) ends it with
 * `audit.seal.duplicate-row` unless the head moved meanwhile. A row `canonicalJson` refuses is
 * sealed with the fallback hash and flagged `audit.row.noncanonical`: no row stops the sealer.
 */
export class AuditSealer {
  private readonly logger = new Logger('AuditSealer');
  private readonly markets = new Map<string, MarketState>();

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly store: AuditChainStore,
    private readonly anchors: AnchorSink,
    private readonly clock: Clock,
  ) {}

  /**
   * One run for the context's Market. Safe to run twice and at once (PA 7.2). A run that throws
   * (the database gone, an unknown error) alerts `audit.seal.failed` with the Market and epoch
   * only, counts toward `audit.seal.stalled` as a run with waiting rows and an unmoved head, and
   * rethrows to the scheduler (Hassan, 6b review M2).
   */
  async run(context: CallContext): Promise<SealRun> {
    const marketId = context.market.marketId;
    const state = this.stateOf(marketId);
    try {
      return await this.runOnce(context, state);
    } catch (error) {
      state.stalledRuns += 1;
      logAuditAlert(this.logger, 'audit.seal.failed', { marketId, epoch: CURRENT_EPOCH });
      this.alertStalled(marketId, state, state.lastHeadSeq ?? null);
      throw error;
    }
  }

  private alertStalled(marketId: string, state: MarketState, headSeq: bigint | null): void {
    if (state.stalledRuns >= STALL_RUNS) {
      logAuditAlert(
        this.logger,
        'audit.seal.stalled',
        { marketId, epoch: CURRENT_EPOCH, chainSeq: headSeq },
        { runs: state.stalledRuns },
      );
    }
  }

  private async runOnce(context: CallContext, state: MarketState): Promise<SealRun> {
    const market = context.market;
    const marketId = market.marketId;
    const started = this.clock.now();
    const deadline = started.add({ milliseconds: RUN_BUDGET_MS });

    let sealed = 0;
    let late = 0;
    let pending = false;
    let head: SealRecord | null = null;
    let ended: SealRun['ended'];
    let first = true;

    for (;;) {
      const now = this.clock.now();
      const settledUntil = now.subtract(SETTLE_WINDOW);
      const scan =
        state.lateScanAt === null ||
        Temporal.Instant.compare(now, state.lateScanAt.add(LATE_SCAN_EVERY)) >= 0;
      const checkLag = first;
      first = false;
      let outcome: BatchOutcome;
      // What the unit read, kept for a conflict: the head it built on and the rows it chose.
      const seen: BatchSeen = { head: null, selected: [] };
      try {
        const result = await this.unitOfWork.run(market, async () =>
          ok(await this.batch(market, now, settledUntil, scan, checkLag, seen)),
        );
        if (!result.ok) throw new Error('AuditSealer: a batch unit returned err');
        outcome = result.value;
      } catch (error) {
        const conflict = await this.conflictOf(error, market, seen.head, seen.selected);
        if (conflict === null) throw error;
        pending = true;
        ended = conflict.ended;
        head = conflict.head ?? head;
        break;
      }

      if (outcome.kind === 'broken') {
        head = outcome.head;
        logAuditAlert(this.logger, 'audit.chain.broken', {
          marketId,
          epoch: CURRENT_EPOCH,
          chainSeq: outcome.head.chainSeq,
          auditLogId: outcome.head.auditLogId,
        });
        ended = 'chain-broken';
        pending = await this.rowsWait(market, settledUntil);
        break;
      }
      if (outcome.kind === 'watermark-future') {
        head = outcome.head;
        logAuditAlert(this.logger, 'audit.seal.watermark-future', {
          marketId,
          epoch: CURRENT_EPOCH,
          chainSeq: outcome.watermark.chainSeq,
          auditLogId: outcome.watermark.auditLogId,
        });
        ended = 'watermark-future';
        pending = await this.rowsWait(market, settledUntil);
        break;
      }
      if (outcome.kind === 'idle') {
        head = outcome.head;
        if (outcome.scanned) state.lateScanAt = now;
        ended = 'idle';
        break;
      }

      // Sealed and committed.
      pending = true;
      if (outcome.scanned) state.lateScanAt = now;
      sealed += outcome.seals.length;
      late += outcome.lateCount;
      head = outcome.seals[outcome.seals.length - 1]!;
      for (const seal of outcome.seals.slice(0, outcome.lateCount)) {
        logAuditAlert(this.logger, 'audit.seal.late-row', {
          marketId,
          epoch: seal.epoch,
          chainSeq: seal.chainSeq,
          auditLogId: seal.auditLogId,
        });
      }
      for (const seal of outcome.flagged) {
        logAuditAlert(this.logger, 'audit.row.noncanonical', {
          marketId,
          epoch: seal.epoch,
          chainSeq: seal.chainSeq,
          auditLogId: seal.auditLogId,
        });
      }
      if (outcome.checkpoint !== null) {
        await this.send('checkpoint', market, outcome.checkpoint);
      }
      if (!outcome.full) {
        ended = 'idle';
        break;
      }
      if (Temporal.Instant.compare(this.clock.now(), deadline) >= 0) {
        ended = 'time-spent';
        break;
      }
    }

    // Step 8: the head moved when this run sealed, or another sealer moved it since last run. A
    // run that stopped the Market (step 1 or 2) is never progress, whatever head it saw: a
    // forged or broken head must not reset the count (Hassan N1 a).
    const stopped = ended === 'chain-broken' || ended === 'watermark-future';
    const headSeq = head?.chainSeq ?? null;
    const moved =
      !stopped &&
      (sealed > 0 || (state.lastHeadSeq !== undefined && state.lastHeadSeq !== headSeq));
    state.lastHeadSeq = headSeq;
    state.stalledRuns = pending && !moved ? state.stalledRuns + 1 : 0;
    this.alertStalled(marketId, state, headSeq);

    // Step 6: the daily heartbeat, never for a Market whose sealing stopped.
    if (
      !stopped &&
      head !== null &&
      (state.heartbeatAt === null ||
        Temporal.Instant.compare(started, state.heartbeatAt.add(HEARTBEAT_EVERY)) >= 0)
    ) {
      if (await this.send('heartbeat', market, head)) state.heartbeatAt = started;
    }

    return { marketId, sealed, late, ended, pending, stalledRuns: state.stalledRuns };
  }

  /** One batch inside its read-write unit (PA 7.1 steps 1 to 5). */
  private async batch(
    market: MarketContext,
    now: Temporal.Instant,
    settledUntil: Temporal.Instant,
    scan: boolean,
    checkLag: boolean,
    seen: BatchSeen,
  ): Promise<BatchOutcome> {
    const epoch = CURRENT_EPOCH;
    const [head, predecessor] = await this.store.lastSeals(market, epoch, 2);
    seen.head = head ?? null;
    seen.selected = [];
    if (head !== undefined && !this.linkHolds(head, predecessor ?? null)) {
      return { kind: 'broken', head };
    }
    const watermark = await this.store.watermark(market, epoch);
    if (watermark !== null && Temporal.Instant.compare(watermark.occurredAt, settledUntil) > 0) {
      return { kind: 'watermark-future', head: head ?? null, watermark };
    }

    const lateRows =
      scan && watermark !== null
        ? await this.store.unsealedRows(
            market,
            epoch,
            watermark.occurredAt.subtract(LATE_SCAN_WINDOW),
            watermark,
            SEAL_BATCH_SIZE,
          )
        : [];
    const room = SEAL_BATCH_SIZE - lateRows.length;
    const rows = room > 0 ? await this.store.rowsAbove(market, watermark, settledUntil, room) : [];
    if (checkLag && rows.length > 0) {
      const oldest = rows[0]!;
      if (Temporal.Instant.compare(oldest.occurredAt.add(LAG_ALERT_AFTER), now) < 0) {
        logAuditAlert(this.logger, 'audit.seal.lagging', {
          marketId: market.marketId,
          epoch,
          auditLogId: oldest.id,
        });
      }
    }
    const selected = [...lateRows, ...rows];
    seen.selected = selected;
    if (selected.length === 0) return { kind: 'idle', head: head ?? null, scanned: scan };

    // Chain positions head + 1, head + 2, ... in (occurred_at, id) order: the late rows are all
    // below the watermark and the batch rows above it (DP 11.8).
    const sealedAt = this.clock.now();
    let prev = head?.chainHash ?? genesisPrev();
    let chainSeq = head?.chainSeq ?? 0n;
    const seals: SealRecord[] = [];
    const flagged: SealRecord[] = [];
    selected.forEach((row, index) => {
      chainSeq += 1n;
      const rowHash = hashAuditRow(row);
      const isLate = index < lateRows.length;
      const chainHash = chainHashOf({
        hashVersion: AUDIT_HASH_VERSION,
        epoch,
        prev,
        chainSeq,
        late: isLate,
        rowHash: rowHash.hash,
      });
      const seal: SealRecord = {
        epoch,
        chainSeq,
        auditLogId: row.id,
        auditOccurredAt: row.occurredAt,
        rowHash: rowHash.hash,
        chainHash,
        late: isLate,
        hashVersion: AUDIT_HASH_VERSION,
        sealedAt,
      };
      seals.push(seal);
      if (!rowHash.canonical) flagged.push(seal);
      prev = chainHash;
    });
    await this.store.insertSeals(market, seals);

    // Step 5: a checkpoint only when the head moved, at the new head (F2).
    const newHead = seals[seals.length - 1]!;
    const last = await this.store.latestCheckpoint(market, epoch);
    const due =
      last === null ||
      newHead.chainSeq - last.chainSeq >= CHECKPOINT_ROWS ||
      Temporal.Instant.compare(now, last.createdAt.add(CHECKPOINT_EVERY)) >= 0;
    let checkpoint: CheckpointRecord | null = null;
    if (due) {
      checkpoint = {
        epoch,
        chainSeq: newHead.chainSeq,
        chainHash: newHead.chainHash,
        hashVersion: newHead.hashVersion,
        createdAt: sealedAt,
      };
      await this.store.insertCheckpoint(market, checkpoint);
    }
    return {
      kind: 'sealed',
      seals,
      lateCount: lateRows.length,
      flagged,
      checkpoint,
      scanned: scan,
      full: selected.length === SEAL_BATCH_SIZE,
    };
  }

  /** Step 1: the head's link recomputes from its predecessor's stored chain hash. */
  private linkHolds(head: SealRecord, predecessor: SealRecord | null): boolean {
    if (!KNOWN_HASH_VERSIONS.includes(head.hashVersion)) return false;
    let prev: Uint8Array;
    if (head.chainSeq === 1n) {
      prev = genesisPrev();
    } else if (predecessor !== null && predecessor.chainSeq === head.chainSeq - 1n) {
      prev = predecessor.chainHash;
    } else {
      return false;
    }
    if (head.chainSeq === 1n && head.late) return false;
    const recomputed = chainHashOf({
      hashVersion: head.hashVersion,
      epoch: head.epoch,
      prev,
      chainSeq: head.chainSeq,
      late: head.late,
      rowHash: head.rowHash,
    });
    return sameHash(recomputed, head.chainHash);
  }

  /**
   * A failed batch: a lost race or a re-selected row (PA 7.1 "Duplicates", 7.2), or null for
   * any other error, which the caller rethrows.
   */
  private async conflictOf(
    error: unknown,
    market: MarketContext,
    before: SealRecord | null,
    selected: readonly AuditRowRecord[],
  ): Promise<{
    ended: 'lost-race' | 'duplicate-row' | 'checkpoint-conflict';
    head: SealRecord | null;
  } | null> {
    if (error instanceof CheckpointConflictError) {
      // An integrity alert: the batch rolled back; the next run meets it again and stalls.
      logAuditAlert(this.logger, 'audit.checkpoint.conflict', {
        marketId: market.marketId,
        epoch: CURRENT_EPOCH,
        chainSeq: before === null ? null : before.chainSeq,
      });
      return { ended: 'checkpoint-conflict', head: before };
    }
    const lostRace =
      error instanceof TransactionConflictError ||
      (error instanceof SealInsertConflictError && error.conflict === 'position-taken');
    const rowSealed = error instanceof SealInsertConflictError && error.conflict === 'row-sealed';
    if (!lostRace && !rowSealed) return null;
    // Which conflict, by SQLSTATE: `23505` on the primary key, or `55P03` / `40P01`.
    const sqlState = error instanceof TransactionConflictError ? error.sqlState : '23505';

    // Read the head again, in a unit of its own.
    const reread = await this.unitOfWork.run(
      market,
      async () => {
        const [head] = await this.store.lastSeals(market, CURRENT_EPOCH, 1);
        const already = rowSealed
          ? await this.store.sealsOfRows(market, CURRENT_EPOCH, selected.map(keyOf))
          : [];
        return ok({ head: head ?? null, already });
      },
      { readOnly: true },
    );
    const head = reread.ok ? reread.value.head : null;
    const moved = head !== null && (before === null || head.chainSeq !== before.chainSeq);
    if (lostRace || (rowSealed && moved)) {
      this.logger.log({
        msg: 'audit.seal.lost-race',
        marketId: market.marketId,
        epoch: CURRENT_EPOCH,
        sqlState,
        constraint: rowSealed
          ? 'row-sealed'
          : lostRace && sqlState === '23505'
            ? 'position-taken'
            : null,
      });
      return { ended: 'lost-race', head };
    }
    for (const seal of reread.ok ? reread.value.already : []) {
      logAuditAlert(this.logger, 'audit.seal.duplicate-row', {
        marketId: market.marketId,
        epoch: seal.epoch,
        chainSeq: seal.chainSeq,
        auditLogId: seal.auditLogId,
      });
    }
    if (!reread.ok || reread.value.already.length === 0) {
      logAuditAlert(this.logger, 'audit.seal.duplicate-row', {
        marketId: market.marketId,
        epoch: CURRENT_EPOCH,
      });
    }
    return { ended: 'duplicate-row', head };
  }

  /**
   * Whether settled rows wait for a seal while this Market's sealing is stopped (step 8,
   * Hassan N1 a), on either side of the watermark: first one settled row above it (the keyset
   * read of every batch), and only when there is none an unsealed row of the current epoch in
   * the last 24 hours up to `now - S` (Mojtaba L1).
   */
  private async rowsWait(market: MarketContext, settledUntil: Temporal.Instant): Promise<boolean> {
    const result = await this.unitOfWork.run(
      market,
      async () => {
        const watermark = await this.store.watermark(market, CURRENT_EPOCH);
        const above = await this.store.rowsAbove(market, watermark, settledUntil, 1);
        if (above.length > 0) return ok(true);
        const below = await this.store.unsealedRows(
          market,
          CURRENT_EPOCH,
          settledUntil.subtract(LATE_SCAN_WINDOW),
          { occurredAt: settledUntil, auditLogId: MAX_UUID },
          1,
        );
        return ok(below.length > 0);
      },
      { readOnly: true },
    );
    return result.ok && result.value;
  }

  /** Sends one anchor; a failure alerts `audit.anchor.failed` and the sealer continues. */
  private async send(
    kind: 'checkpoint' | 'heartbeat',
    market: MarketContext,
    head: Pick<SealRecord, 'epoch' | 'chainSeq' | 'chainHash' | 'hashVersion'>,
  ): Promise<boolean> {
    const anchor: ChainAnchor = {
      marketId: market.marketId,
      epoch: head.epoch,
      chainSeq: head.chainSeq,
      chainHash: chainHashText(head.chainHash),
      hashVersion: head.hashVersion,
      at: this.clock.now(),
    };
    try {
      await (kind === 'checkpoint'
        ? this.anchors.checkpoint(anchor)
        : this.anchors.heartbeat(anchor));
      return true;
    } catch {
      logAuditAlert(
        this.logger,
        'audit.anchor.failed',
        { marketId: market.marketId, epoch: head.epoch, chainSeq: head.chainSeq },
        { anchor: kind },
      );
      return false;
    }
  }

  private stateOf(marketId: string): MarketState {
    let state = this.markets.get(marketId);
    if (state === undefined) {
      state = { lateScanAt: null, heartbeatAt: null, lastHeadSeq: undefined, stalledRuns: 0 };
      this.markets.set(marketId, state);
    }
    return state;
  }
}
