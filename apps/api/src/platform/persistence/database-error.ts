/**
 * Database errors never reach a log or a response whole (platform persistence design, "P",
 * 12.3; PH3, decided by Hassan). A CHECK violation carries the whole failing row in
 * `meta.driverAdapterError.cause.detail`, and a malformed id puts the input value in the
 * message. This one function keeps the error's name, Prisma code, SQLSTATE and constraint
 * name; the logger uses it for every error it serialises. `message`, `meta` (with its `cause`
 * and `detail`) and query parameters are never kept.
 *
 * It reads plain shapes and imports nothing of Prisma, so `platform/logging` may use it
 * (dependency-cruiser `persistence-internals-are-private` lists this file).
 */
export interface ReducedDatabaseError {
  readonly name: string;
  /** `P2002`, `P2028`, ... */
  readonly prismaCode?: string;
  /** PostgreSQL's SQLSTATE, from the two places the classifier reads (P 3.1 row 7). */
  readonly sqlState?: string;
  readonly constraint?: string;
}

const PRISMA_ERROR = /^PrismaClient\w*Error$/;
const PRISMA_CODE = /^P\d{4}$/;
const SQLSTATE = /^[0-9A-Z]{5}$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
/** PostgreSQL's wording for every integrity violation names the constraint last. */
const CONSTRAINT_IN_MESSAGE = /constraint "([A-Za-z_][A-Za-z0-9_$]{0,62})"$/;

type Loose = Record<string, unknown>;

const asObject = (value: unknown): Loose | undefined =>
  typeof value === 'object' && value !== null ? (value as Loose) : undefined;

const matching = (value: unknown, pattern: RegExp): string | undefined =>
  typeof value === 'string' && pattern.test(value) ? value : undefined;

function constraintOf(cause: Loose | undefined, sqlState: string | undefined): string | undefined {
  const named = matching(asObject(cause?.constraint)?.index, IDENTIFIER);
  if (named !== undefined) return named;
  // Integrity violations (class 23) name the constraint at the end of the message, after
  // any value; only the identifier is taken.
  if (sqlState?.startsWith('23') && typeof cause?.originalMessage === 'string') {
    return CONSTRAINT_IN_MESSAGE.exec(cause.originalMessage)?.[1];
  }
  return undefined;
}

/** The reduced form of a Prisma or driver-adapter error; undefined for any other value. */
export function reduceDatabaseError(error: unknown): ReducedDatabaseError | undefined {
  const object = asObject(error);
  const name = typeof object?.name === 'string' ? object.name : undefined;
  if (object === undefined || name === undefined) return undefined;

  let cause: Loose | undefined;
  if (PRISMA_ERROR.test(name)) {
    cause = asObject(asObject(asObject(object.meta)?.driverAdapterError)?.cause);
  } else if (name === 'DriverAdapterError') {
    cause = asObject(object.cause);
  } else {
    return undefined;
  }

  const prismaCode = matching(object.code, PRISMA_CODE);
  const sqlState = matching(cause?.originalCode, SQLSTATE);
  const constraint = constraintOf(cause, sqlState);
  return {
    name,
    ...(prismaCode === undefined ? {} : { prismaCode }),
    ...(sqlState === undefined ? {} : { sqlState }),
    ...(constraint === undefined ? {} : { constraint }),
  };
}
