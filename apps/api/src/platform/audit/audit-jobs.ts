import { Temporal } from '@mondapac-drive/shared-kernel';
import type { Clock } from '@mondapac-drive/shared-kernel';
import type { JobContext, JobDefinition } from '../scheduler/job-registry';
import {
  FULL_VERIFY_EVERY,
  SEAL_JOB_EVERY,
  SEAL_JOB_MAX_RUN_MS,
  VERIFY_JOB_EVERY,
  VERIFY_JOB_MAX_RUN_MS,
} from './audit-chain-policy';
import type { AuditSealer } from './audit-sealer';
import type { AuditVerifier, VerifyMode } from './audit-verifier';

/** The job names (docs/design/domain/platform-audit.md 7, 8; P 7 "Phase 2"). */
export const AUDIT_SEAL_JOB = 'platform.audit-seal';
export const AUDIT_VERIFY_JOB = 'platform.audit-verify';

/**
 * `platform.audit-seal` (PA 7): every 10 s, at most 60 s a run, per hosted Market with the
 * scheduler's system context. It starts at once when the worker starts, so the late-row scan
 * of the first run is never pushed back by restarts (F3). Only the worker role runs jobs.
 */
export function auditSealJob(sealer: AuditSealer): JobDefinition {
  return {
    name: AUDIT_SEAL_JOB,
    every: SEAL_JOB_EVERY,
    maxRunMs: SEAL_JOB_MAX_RUN_MS,
    runAtStart: true,
    async run(context: JobContext): Promise<void> {
      await sealer.run(context);
    },
  };
}

/**
 * `platform.audit-verify` (PA 8): every hour an incremental check from the last checkpoint,
 * and a full check when this process has not completed one for that Market in the last 24
 * hours, so the first run after the worker starts is full; a full run that did not complete
 * is not counted. Findings are alerts only.
 */
export function auditVerifyJob(verifier: AuditVerifier, clock: Clock): JobDefinition {
  const lastFull = new Map<string, Temporal.Instant>();
  return {
    name: AUDIT_VERIFY_JOB,
    every: VERIFY_JOB_EVERY,
    maxRunMs: VERIFY_JOB_MAX_RUN_MS,
    async run(context: JobContext): Promise<void> {
      const marketId = context.market.marketId;
      const started = clock.now();
      const previous = lastFull.get(marketId);
      const mode: VerifyMode =
        previous === undefined ||
        Temporal.Instant.compare(started, previous.add(FULL_VERIFY_EVERY)) >= 0
          ? 'full'
          : 'incremental';
      const report = await verifier.verify(context, mode);
      // Only a completed full run counts: one that ran out of budget is retried full on the
      // next tick (Mohammad, round 2 C1).
      if (mode === 'full' && report.complete) lastFull.set(marketId, started);
    },
  };
}
