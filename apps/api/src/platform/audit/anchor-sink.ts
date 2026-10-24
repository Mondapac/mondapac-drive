import { Logger } from '@nestjs/common';
import type { ContentHash, MarketId, Temporal } from '@mondapac-drive/shared-kernel';

/**
 * One chain head copied outside the database (docs/design/domain/platform-audit.md 7.1 steps 5
 * and 6, 8). The hash is in `ContentHash` text form (`sha256:`), the form of every boundary
 * (PA 6.3, F8). Ids and codes only: an anchor holds no row content.
 */
export interface ChainAnchor {
  readonly marketId: MarketId;
  readonly epoch: number;
  readonly chainSeq: bigint;
  readonly chainHash: ContentHash;
  readonly hashVersion: number;
  /** From the sealer's Clock. */
  readonly at: Temporal.Instant;
}

/**
 * The external copy of chain checkpoints (PA 8). `checkpoint` is sent after the unit that
 * inserted the checkpoint row commits; `heartbeat` once a day per Market with the current
 * head, whether or not it moved, and with no checkpoint row (PA 7.1 step 6). A failed send
 * alerts `audit.anchor.failed`; the sealer continues and the next checkpoint sends again.
 *
 * Phase 2 binds {@link LogAnchorSink}. The Object Lock anchor (compliance mode, put-only
 * credential, conditional writes, staleness monitor, readable side) is part of the hardening
 * set of ADR-0032, due before the hardening trigger.
 */
export interface AnchorSink {
  checkpoint(anchor: ChainAnchor): Promise<void>;
  heartbeat(anchor: ChainAnchor): Promise<void>;
}

/** Nest token of the {@link AnchorSink}. */
export const ANCHOR_SINK = Symbol('ANCHOR_SINK');

/**
 * The readable side of the anchor (PA 8 (f), `AnchorSource`): every stored version of every
 * checkpoint anchor of a Market and epoch. Not bound in Phase 2: the log anchor cannot be read
 * back, so check (f) is a runbook comparison against the logs until the Object Lock anchor
 * exists (ADR-0032 decision 2). The verifier runs check (f) whenever one is bound; the tests
 * bind a recording fake.
 */
export interface AnchorSource {
  /** The anchors of `epoch`, each with every version stored under its key. */
  anchors(marketId: MarketId, epoch: number): Promise<readonly StoredAnchor[]>;
}

/** One anchor key and the versions stored under it (an idempotent key alone is not enough). */
export interface StoredAnchor {
  readonly chainSeq: bigint;
  readonly versions: readonly ContentHash[];
}

/** Nest token of the {@link AnchorSource}; optional. */
export const ANCHOR_SOURCE = Symbol('ANCHOR_SOURCE');

/**
 * The Phase 2 anchor (PA 8, Hassan Q8): one structured log line per checkpoint
 * (`audit.checkpoint`) and per heartbeat (`audit.heartbeat`), with Market, epoch, `chain_seq`,
 * the chain hash as `sha256:` and the instant. It can be written but not read back. Accepted
 * only while no environment of the hardening trigger exists and all data is synthetic.
 */
export class LogAnchorSink implements AnchorSink {
  private readonly logger = new Logger('AuditAnchor');

  checkpoint(anchor: ChainAnchor): Promise<void> {
    this.logger.log({ msg: 'audit.checkpoint', ...lineOf(anchor) });
    return Promise.resolve();
  }

  heartbeat(anchor: ChainAnchor): Promise<void> {
    this.logger.log({ msg: 'audit.heartbeat', ...lineOf(anchor) });
    return Promise.resolve();
  }
}

function lineOf(anchor: ChainAnchor) {
  return {
    marketId: anchor.marketId,
    epoch: anchor.epoch,
    // A bigint is not JSON: log lines carry chain_seq as a string (DP 11.3).
    chainSeq: anchor.chainSeq.toString(),
    chainHash: anchor.chainHash,
    hashVersion: anchor.hashVersion,
    at: anchor.at.toString(),
  };
}
