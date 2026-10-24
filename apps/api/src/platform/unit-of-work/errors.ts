/**
 * The error classes of the UnitOfWork and the market guard (platform persistence design, "P",
 * sections 3, 4 and 10). No Prisma here: `application/` code may import them. Each carries
 * a fixed message and, where stated, one machine-readable field; never a value from a query,
 * a row or a driver message (P 12.3).
 */

/** `UnitOfWork.run` was called inside an open unit (P 3.1 row 4): no join, no savepoint. */
export class NestedUnitOfWorkError extends Error {
  override readonly name = 'NestedUnitOfWorkError';
  constructor() {
    super('A unit of work is already open in this async context; units do not nest');
  }
}

/** `PrismaService.tx(market)` was called with no open unit, or after it closed (P 3.3). */
export class NoUnitOfWorkError extends Error {
  override readonly name = 'NoUnitOfWorkError';
  constructor() {
    super('No open unit of work: open one with UnitOfWork.run before using the database');
  }
}

/** `tx(market)` was given another Market or tenant than the open unit's (P 3.3). */
export class MarketMismatchError extends Error {
  override readonly name = 'MarketMismatchError';
  constructor() {
    super('The MarketContext is not the one the open unit of work was opened for');
  }
}

/** `run` was given a MarketContext that was not minted (P 3.1 row 2). */
export class UnmintedMarketContextError extends Error {
  override readonly name = 'UnmintedMarketContextError';
  constructor() {
    super('A unit of work is opened only for a minted MarketContext');
  }
}

/** Options `run` refuses (P 3.1 rows 8 and 9; ADR-0025 condition (c)). */
export class InvalidUnitOfWorkOptionsError extends Error {
  override readonly name = 'InvalidUnitOfWorkOptionsError';
  constructor(readonly reason: InvalidUnitOfWorkOptionsReason) {
    super(`Invalid unit of work options: ${reason}`);
  }
}

export type InvalidUnitOfWorkOptionsReason =
  | 'read-only-with-isolation'
  | 'read-only-with-timeout'
  | 'read-only-with-lock-timeout'
  | 'read-only-run-once'
  | 'unknown-isolation'
  | 'timeout-out-of-range'
  | 'lock-timeout-out-of-range';

/**
 * The market guard refused a query (P 4). The reason is one of a closed set of codes, with the
 * model and operation names (identifiers from the schema, never values).
 */
export class MarketGuardError extends Error {
  override readonly name = 'MarketGuardError';
  constructor(
    readonly reason: MarketGuardRefusal,
    readonly model: string | null,
    readonly operation: string,
  ) {
    super(`Market guard refused ${model ?? 'client'}.${operation}: ${reason}`);
  }
}

export type MarketGuardRefusal =
  | 'no-open-unit'
  | 'unit-closed'
  | 'unknown-model'
  | 'unknown-operation'
  | 'raw-sql'
  | 'write-in-read-only-unit'
  | 'where-missing'
  | 'where-unknown-key'
  | 'where-market-missing'
  | 'where-market-mismatch'
  | 'selector-market-mismatch'
  | 'selector-tenant-mismatch'
  | 'selector-malformed'
  | 'cursor-malformed'
  | 'cursor-unknown-key'
  | 'cursor-market-missing'
  | 'cursor-market-mismatch'
  | 'upsert-by-id'
  | 'upsert-without-market-selector'
  | 'data-missing'
  | 'data-market-mismatch'
  | 'data-tenant-mismatch'
  | 'data-changes-market'
  | 'nested-write';

/**
 * A serialisation failure or deadlock after three attempts, or a lock timeout at once (P 3.1
 * row 7). It carries the SQLSTATE and nothing else (P 12.3). HTTP: 409 `conflict.retry`.
 */
export class TransactionConflictError extends Error {
  override readonly name = 'TransactionConflictError';
  constructor(readonly sqlState: ConflictSqlState) {
    super(`The transaction could not complete because of a concurrent change (${sqlState})`);
  }
}

/** The SQLSTATEs that make a {@link TransactionConflictError}. */
export type ConflictSqlState = '40001' | '40P01' | '55P03';

/**
 * A save found the aggregate changed since it was loaded (P 10). Aggregate type and id only.
 * HTTP: 409 `conflict.stale`.
 */
export class StaleAggregateError extends Error {
  override readonly name = 'StaleAggregateError';
  constructor(
    readonly aggregateType: string,
    readonly aggregateId: string,
  ) {
    super(`The ${aggregateType} was changed by someone else since it was read`);
  }
}

/**
 * A named raw statement (platform persistence design 4.2) refused its input or its result. The
 * reason is one of a closed set; the statement name is an identifier from the checked-in list;
 * no id, row or value (P 12.3).
 */
export class NamedStatementRefusedError extends Error {
  override readonly name = 'NamedStatementRefusedError';
  constructor(
    readonly statement: string,
    readonly reason: NamedStatementRefusal,
  ) {
    super(`Named statement ${statement} refused: ${reason}`);
  }
}

export type NamedStatementRefusal =
  'read-only-unit' | 'ids-empty' | 'ids-too-many' | 'ids-malformed' | 'rows-missing';
