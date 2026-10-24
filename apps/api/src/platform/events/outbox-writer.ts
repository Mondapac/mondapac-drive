import type { CallContext, Id, PendingEvent } from '@mondapac-drive/shared-kernel';

/**
 * Writes the events of one module into its own outbox, in the open read-write unit of the
 * state change (P 5.2; ADR-0006 decision 2). The use case calls it inside `work`, after its
 * repository saved the aggregate, with the `CallContext` it received (foundations 5.2 rule 2).
 *
 * It stamps the event id (`IdGenerator`), the Market and tenant and the correlation id (the
 * context, never the aggregate's or the caller's data), and the causation id (`causedBy`, or
 * `null`); see P 5.1. The actor is not written: an event has no actor field (ADR-0018 decision
 * 4). It throws, so that the unit rolls back and an event is never dropped silently, when: the
 * context was not minted; no unit is open, or the unit is read-only; the context's Market is
 * not the unit's; a type is not this module's or not in the event catalogue; an aggregate type,
 * id or version (1 to 2^31 - 1) is malformed; the payload does not match its definition.
 */
export interface OutboxWriter {
  append(context: CallContext, events: readonly PendingEvent[], causedBy?: Id): Promise<void>;
}

/** Binds an {@link OutboxWriter} to one module's outbox (P 5.2). */
export interface OutboxWriterFactory {
  forModule(module: string): OutboxWriter;
}

/**
 * Nest token of a module's own {@link OutboxWriter}. A module binds it with
 * `PersistenceModule.outboxWriterFor` and never exports it. There is deliberately
 * no token of the {@link OutboxWriterFactory}: an injectable factory would let any module ask
 * for another module's writer (security review of slice 1b, M1).
 */
export const OUTBOX_WRITER = Symbol('OUTBOX_WRITER');

/** Why the outbox writer refused (P 5.2). Codes and, for a payload, the declared field name. */
export type OutboxRefusal =
  | 'context-not-minted'
  | 'read-only-unit'
  | 'correlation-id-invalid'
  | 'causation-id-invalid'
  | 'type-of-another-module'
  | 'type-not-in-catalogue'
  | 'aggregate-type-mismatch'
  | 'aggregate-id-invalid'
  | 'version-out-of-range'
  | 'occurred-at-invalid'
  | 'payload-invalid';

/**
 * The outbox writer refused an event or a call (P 5.2). It carries the reason and, for a
 * payload, the declared field name: never a value.
 */
export class OutboxWriteRefusedError extends Error {
  override readonly name = 'OutboxWriteRefusedError';
  constructor(
    readonly reason: OutboxRefusal,
    readonly field: string | null = null,
  ) {
    super(`The outbox writer refused: ${reason}${field === null ? '' : ` (${field})`}`);
  }
}

/**
 * Answers whether a permission key is known to the `PermissionRegistry` or its retired list
 * (foundations 6.1), for `permissionKey` payload fields (P 5.3). Since identity slice 8a-1 the
 * binding is the registry itself (`AuthzModule`).
 */
export interface PermissionKeyLookup {
  isKnownPermissionKey(key: string): boolean;
}

export const PERMISSION_KEY_LOOKUP = Symbol('PERMISSION_KEY_LOOKUP');

/**
 * A lookup that knows no key: every `permissionKey` field is refused. The production binding
 * before identity slice 8a-1; now only for tests of a writer that carries no such field.
 */
export const NO_PERMISSION_KEYS: PermissionKeyLookup = Object.freeze({
  isKnownPermissionKey: () => false,
});
