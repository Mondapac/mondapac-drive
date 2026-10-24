// The checked-in list of raw read statements (ADR-0030 decision 2). This is the only place a
// raw read statement may be added; a change needs the sign-off of Ali, Hassan and Mojtaba,
// recorded in the PR, and Mojtaba's plan review of the changed statement (CODEOWNERS names the
// owner's account for this folder). Imports are types only, so the boundary script can load
// this file without the application's dependencies.

/** A parameter's PostgreSQL type. `$1` is the Market and is never declared. */
export type RawReadParamType = 'uuid' | 'text' | 'uuid[]' | 'text[]';

export interface RawReadParam {
  /** The key of the caller's parameter object. */
  readonly name: string;
  readonly type: RawReadParamType;
  /** The most elements an array may hold; required for an array, refused for a scalar. */
  readonly maxLength?: number;
  /** Arrays zipped by one `unnest` share a group and must have equal lengths. */
  readonly group?: string;
}

export interface RawReadEntry<Row = unknown> {
  /** `<owning module>.<name>`, e.g. `delivery.nearby-couriers`. */
  readonly id: string;
  /** The owning module: its schema is the only schema the text may read, and only it may call. */
  readonly owner: string;
  /** Why Prisma does not suffice. */
  readonly reason: string;
  /** The design section that specifies the statement. */
  readonly design: string;
  /** One `SELECT` or `WITH` statement as a static constant; `$1` is the Market. */
  readonly sql: string;
  /** `$2` onwards, in this order. */
  readonly params: readonly RawReadParam[];
  /** Validates one result row; throws on a row that does not fit (the whole call fails closed). */
  readonly parseRow: (row: unknown) => Row;
}

/**
 * The parameters and row of each listed statement, by id. Drive lists none yet: a module adds
 * its entry here and to {@link RAW_READ_STATEMENTS} in the same change.
 */
export type RawReadStatements = Record<never, never>;

export type RawReadName = keyof RawReadStatements;
export type RawReadParams<K extends RawReadName> = RawReadStatements[K] extends {
  readonly params: infer P;
}
  ? P
  : never;
export type RawReadRow<K extends RawReadName> = RawReadStatements[K] extends {
  readonly row: infer R;
}
  ? R
  : never;

/** The list. Empty until a module needs a read Prisma cannot express. */
export const RAW_READ_STATEMENTS: readonly RawReadEntry[] = [];
