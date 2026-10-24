import type { Logger } from '@nestjs/common';

/**
 * The fixed codes of the audit chain's alerts and findings (docs/design/domain/platform-audit.md
 * 7.1, 8, 9). Each is one error-level log line marked `alert: true` (the mechanism of dead
 * letters, P 6.4; routing is PK3), holding the Market, the epoch, `chain_seq` and the audit id
 * only, never row content. A finding has no effect on business traffic.
 */
export type AuditAlertCode =
  // Sealer (PA 7.1, 9).
  | 'audit.chain.broken'
  | 'audit.seal.watermark-future'
  | 'audit.seal.late-row'
  | 'audit.seal.lagging'
  | 'audit.seal.stalled'
  | 'audit.seal.duplicate-row'
  | 'audit.anchor.failed'
  | 'audit.seal.failed'
  | 'audit.checkpoint.conflict'
  // Sealer and verifier (PA 6.2, 8 (k)).
  | 'audit.row.noncanonical'
  // Verifier (PA 8 (a) to (j)).
  | 'audit.chain.gap'
  | 'audit.seal.unknown-epoch'
  | 'audit.row.mismatch'
  | 'audit.row.missing'
  | 'audit.row.unsealed'
  | 'audit.checkpoint.mismatch'
  | 'audit.anchor.mismatch'
  | 'audit.seal.time-mismatch'
  | 'audit.seal.out-of-order'
  | 'audit.seal.hash-version'
  | 'audit.row.future'
  | 'audit.row.out-of-range'
  | 'audit.seal.out-of-range'
  | 'audit.checkpoint.out-of-range'
  | 'audit.verify.incomplete';

/** What one alert line names: ids and positions only. */
export interface AuditAlertSubject {
  readonly marketId: string;
  readonly epoch?: number | null;
  readonly chainSeq?: bigint | null;
  readonly auditLogId?: string | null;
}

/** Writes one alert line: error level, `alert: true`, `chain_seq` as a string. */
export function logAuditAlert(
  logger: Pick<Logger, 'error'>,
  code: AuditAlertCode,
  subject: AuditAlertSubject,
  extra: Readonly<Record<string, string | number | boolean>> = {},
): void {
  logger.error({
    msg: code,
    alert: true,
    marketId: subject.marketId,
    epoch: subject.epoch ?? null,
    chainSeq:
      subject.chainSeq === undefined || subject.chainSeq === null ? null : String(subject.chainSeq),
    auditLogId: subject.auditLogId ?? null,
    ...extra,
  });
}
