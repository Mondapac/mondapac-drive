import type { AuditEntry, CallContext } from '@mondapac-drive/shared-kernel';

/**
 * Writes one audit row into `platform.audit_log`, inside the caller's open read-write unit
 * (docs/design/domain/platform-audit.md 3.1, W1 to W6; ADR-0004 decision 7). Bound per module:
 * a module reaches only its own writer, through its `AUDIT_WRITER` token, and may record only
 * the actions of its own catalogue entries.
 *
 * - W1: it uses `tx(context.market)` and never opens a unit. It refuses when no unit is open,
 *   when the unit is read-only, or when the context's Market is not the unit's.
 * - W2: the actor comes from the context (`authenticated` is `USER` with the account id,
 *   `system` is `SYSTEM`, `anonymous` is `ANONYMOUS`); the caller supplies no actor column.
 * - W3: the id (UUIDv7), Market, tenant and correlation id come from the context and the
 *   platform; `occurred_at` is `Clock.now()` read here, in whole milliseconds.
 * - W4, W4a: the entry must match its sealed catalogue definition exactly (actors, target,
 *   fields, list maxima, at most {@link MAX_AUDIT_SIDE_BYTES} of canonical JSON per side, known
 *   permission keys); an `ANONYMOUS` row names its `boundSubjectId`.
 * - W5: every refusal throws {@link AuditWriteRefusedError}, so the unit rolls back.
 * - W6: one call per audited action; several per use case are fine.
 */
export interface AuditWriter {
  record(context: CallContext, entry: AuditEntry): Promise<void>;
}

/**
 * Nest token of a module's own {@link AuditWriter}. A module binds it with
 * `PersistenceModule.auditWriterFor('<module>')` and never exports it; there is deliberately no
 * token of a writer factory, so no module can ask for another module's writer (PA 2, the
 * pattern of `OUTBOX_WRITER`). Identity slice 6a binds it into no module: the writer is
 * reachable from tests only until 6b (Ali's condition 1 on the split).
 */
export const AUDIT_WRITER = Symbol('AUDIT_WRITER');

/**
 * The most canonical JSON one side (`before` or `after`) may hold, in UTF-8 bytes (PA W4). The
 * database caps the text form at 8 192 bytes (`audit_log_before_size_check`), which every side
 * within this limit stays under (docs/design/data/platform.md 11.2).
 */
export const MAX_AUDIT_SIDE_BYTES = 4096;

/** Why the audit writer refused (PA W5). Codes and, for a field, its declared name. */
export type AuditRefusal =
  | 'context-not-minted'
  | 'no-open-unit'
  | 'read-only-unit'
  | 'market-mismatch'
  | 'correlation-id-invalid'
  | 'catalogue-not-sealed'
  | 'entry-invalid'
  | 'action-of-another-owner'
  | 'action-not-in-catalogue'
  | 'target-type-mismatch'
  | 'target-id-invalid'
  | 'actor-not-allowed'
  | 'before-undeclared'
  | 'after-undeclared'
  | 'before-invalid'
  | 'after-invalid'
  | 'list-too-long'
  | 'before-too-large'
  | 'after-too-large'
  | 'bound-subject-missing';

/**
 * The audit writer refused an entry or a call (PA W5). It carries the reason and, for a field,
 * the declared field name: never a value, so it can be logged as it is.
 */
export class AuditWriteRefusedError extends Error {
  override readonly name = 'AuditWriteRefusedError';
  constructor(
    readonly reason: AuditRefusal,
    readonly field: string | null = null,
  ) {
    super(`The audit writer refused: ${reason}${field === null ? '' : ` (${field})`}`);
  }
}
