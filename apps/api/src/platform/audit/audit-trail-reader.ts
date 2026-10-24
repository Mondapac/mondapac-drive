import type { MarketContext, Result, Temporal } from '@mondapac-drive/shared-kernel';

/** One `platform.audit_log` row of a module's own history, as its reader returns it. */
export interface AuditTrailEntry {
  /** The row's id: also the cursor of the next page ({@link AuditTrailQuery.after}). */
  readonly id: string;
  readonly occurredAt: Temporal.Instant;
  readonly actorType: 'USER' | 'SYSTEM' | 'ANONYMOUS';
  /**
   * The account that acted, as stored (PA 10, Hassan I4): it may be an admin's. The consuming
   * module maps it before anything is shown to a seller.
   */
  readonly actorId: string | null;
  /** The sides as stored: what the action's catalogue definition encoded (W4). */
  readonly before: unknown;
  readonly after: unknown;
}

export interface AuditTrailQuery {
  /** One action of the reader's own module, registered in the catalogue. */
  readonly action: string;
  /** The target the rows name; its type is the action's declared target type. */
  readonly targetId: string;
  /** The id of the last row of the previous page; null for the first page. */
  readonly after: string | null;
  /** 1 to {@link MAX_AUDIT_TRAIL_PAGE}. */
  readonly limit: number;
}

/** The largest page one read returns. */
export const MAX_AUDIT_TRAIL_PAGE = 100;

/**
 * The history of one target in one module's own audit rows (docs/design/domain/platform-audit.md
 * 10, `AuditTrailReader`), bound per module like the writer: a module reaches only its own reader,
 * through its {@link AUDIT_TRAIL_READER} token, and reads only actions its own catalogue entries
 * declare, of their declared target type, in the context's Market. Newest first, keyset paged on
 * `(occurred_at, id)` over the target index of `audit_log` (DP 11.7), bounded to
 * `AUDIT_TIME_RANGE`. It runs in the caller's open unit (read-only or read-write) and never opens
 * one; it is called from the module's own use case, under the module's own key, which decides
 * who may see the history. `chain_seq` and `late` are not read: no consumer shows them yet.
 *
 * An action that is not the module's own, or not in the catalogue, throws
 * {@link AuditReadRefusedError} (a programming error, never a caller's input). A cursor that names
 * no row of this history is `cursor.unknown`.
 */
export interface AuditTrailReader {
  history(
    market: MarketContext,
    query: AuditTrailQuery,
  ): Promise<Result<readonly AuditTrailEntry[], { readonly code: 'cursor.unknown' }>>;
}

/** Why the reader refused a call. Codes only. */
export type AuditReadRefusal =
  'catalogue-not-sealed' | 'action-not-in-catalogue' | 'action-of-another-owner' | 'limit-invalid';

export class AuditReadRefusedError extends Error {
  override readonly name = 'AuditReadRefusedError';
  constructor(readonly reason: AuditReadRefusal) {
    super(`The audit trail reader refused: ${reason}`);
  }
}

/**
 * Nest token of a module's own {@link AuditTrailReader}. A module binds it with
 * `PersistenceModule.auditTrailReaderFor('<module>')` and never exports it, as `AUDIT_WRITER`.
 */
export const AUDIT_TRAIL_READER = Symbol('AUDIT_TRAIL_READER');
