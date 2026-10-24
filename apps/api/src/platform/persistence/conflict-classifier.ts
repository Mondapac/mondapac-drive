import { Prisma } from '../../generated/prisma/client';
import type { ConflictSqlState } from '../unit-of-work/errors';

/**
 * The conflict classifier of the UnitOfWork (platform persistence design, "P", 3.1 row 7).
 * It decides from the SQLSTATE alone, read in exactly two places, the two shapes spike 6
 * recorded (P 14):
 *
 * - at a statement: a `PrismaClientKnownRequestError` (P2034, P2039, P2010, ...) with the code
 *   in `meta.driverAdapterError.cause.originalCode`;
 * - at COMMIT: an error named `DriverAdapterError` (no Prisma code, `meta` null) with the code
 *   in `cause.originalCode`.
 *
 * It walks no nested cause and never decides from a Prisma code alone (`P2034`, `P2010`).
 */
export interface ConflictClass {
  /** `40001` and `40P01` are retried; `55P03` (lock timeout) is a conflict at once. */
  readonly retry: boolean;
  readonly sqlState: ConflictSqlState;
}

const RETRIED = new Set<string>(['40001', '40P01']);
const LOCK_NOT_AVAILABLE = '55P03';

function originalCodeOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const code = (value as { originalCode?: unknown }).originalCode;
  return typeof code === 'string' ? code : undefined;
}

/** The SQLSTATE of a database error, from the two documented places only. */
export function sqlStateOf(error: unknown): string | undefined {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const adapterError = (error.meta as { driverAdapterError?: { cause?: unknown } } | undefined)
      ?.driverAdapterError;
    return originalCodeOf(adapterError?.cause);
  }
  if (error instanceof Error && error.name === 'DriverAdapterError') {
    return originalCodeOf(error.cause);
  }
  return undefined;
}

/** A conflict and whether to retry it, or null for anything else (which `run` rethrows). */
export function classifyConflict(error: unknown): ConflictClass | null {
  const sqlState = sqlStateOf(error);
  if (sqlState === undefined) return null;
  if (RETRIED.has(sqlState)) return { retry: true, sqlState: sqlState as ConflictSqlState };
  if (sqlState === LOCK_NOT_AVAILABLE) return { retry: false, sqlState: LOCK_NOT_AVAILABLE };
  return null;
}
