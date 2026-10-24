import type { MarketContext, Result } from '@mondapac-drive/shared-kernel';
import type { EventDelivery } from '../events/event-delivery';

/**
 * Options of one unit (platform persistence design, "P", 3.1). Defaults: read-write, READ
 * COMMITTED (the database default; nothing is sent for it, ADR-0025 decision 2), 5000 ms.
 */
export interface UnitOfWorkOptions {
  /**
   * Opens no transaction (ADR-0025): `work` runs once on the guarded client, which refuses
   * every write. Refused together with `isolation` or `timeoutMs`.
   */
  readonly readOnly?: boolean;
  /** For invariants that span rows (P 3.1 row 6). */
  readonly isolation?: 'serializable';
  /** The read-write unit's timeout, at most {@link MAX_UNIT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /**
   * How long a statement of this unit may wait for a row lock, at most
   * {@link MAX_LOCK_TIMEOUT_MS} (inventory data design 4.2 L7). Issued by the persistence layer
   * as `SET LOCAL lock_timeout`, the first statement of every attempt; a wait that runs out
   * ends the unit with `TransactionConflictError` (55P03). Absent: the login role's own
   * `lock_timeout` (platform data design 10.8). Refused for a read-only unit.
   */
  readonly lockTimeoutMs?: number;
}

/**
 * The transaction boundary of a use case (P 3; ADR-0004 decision 5 as amended by ADR-0023 and
 * ADR-0025). The use-case body calls `run` itself, after its authorisation and its slow work
 * (P 3.4, T1 option A); at most one read-write unit per use case.
 *
 * - `ok` commits; `err` commits nothing and is returned unchanged; an exception commits
 *   nothing and is rethrown (P 3.1 row 3).
 * - `run` inside an open unit throws `NestedUnitOfWorkError` (row 4).
 * - `work` may run up to three times on a serialisation failure or deadlock (row 7): it
 *   reloads what it changes and does nothing external (no hashing, HTTP, mail, facade or model
 *   call; row 5).
 */
export interface UnitOfWork {
  run<T, E>(
    market: MarketContext,
    work: () => Promise<Result<T, E>>,
    options?: UnitOfWorkOptions,
  ): Promise<Result<T, E>>;

  /**
   * The unit of an event-handling use case (P 6.4; ADR-0006 decision 5): one read-write unit
   * that inserts `(eventId, subscriber)` into the subscriber's module inbox, runs `work` only
   * when that row is new, and marks the delivery delivered, all in one transaction. A
   * repeated delivery therefore commits nothing but the mark and answers `{ handled: false }`.
   * `err` and an exception commit nothing, so the delivery comes due again. External work (a
   * mail) is done before `runOnce`, never inside it (P 3.1 row 5). The delivery must be one the
   * dispatcher handed out, for this Market; anything else throws. A read-only unit is refused.
   */
  runOnce<T, E>(
    market: MarketContext,
    delivery: EventDelivery,
    work: () => Promise<Result<T, E>>,
    options?: Omit<UnitOfWorkOptions, 'readOnly'>,
  ): Promise<Result<HandledOnce<T>, E>>;
}

/** What `runOnce` did: ran the work, or found the event already handled by this subscriber. */
export type HandledOnce<T> =
  { readonly handled: true; readonly value: T } | { readonly handled: false };

/** Nest injection token of the {@link UnitOfWork} port. */
export const UNIT_OF_WORK = Symbol('UNIT_OF_WORK');

/** Prisma's default interactive-transaction timeout, the default of a read-write unit (P 3.1 row 8). */
export const DEFAULT_UNIT_TIMEOUT_MS = 5000;
/** The most a unit may ask for with `timeoutMs` (P 3.1 row 8). */
export const MAX_UNIT_TIMEOUT_MS = 30_000;
/**
 * The most a unit may ask for with `lockTimeoutMs`: the role-level `lock_timeout` is at most 3 s
 * (start-up check `role_timeouts`). A unit that asks for more than a role set lower gets
 * the larger value, never above this ceiling.
 */
export const MAX_LOCK_TIMEOUT_MS = 3000;
/** The longest wait for a pooled connection, in a transaction and for every statement (row 8). */
export const CONNECTION_WAIT_MS = 2000;
/** Attempts of a read-write unit on `40001` or `40P01` (row 7). */
export const UNIT_ATTEMPTS = 3;
