import { Prisma } from '../../generated/prisma/client';
import { reduceDatabaseError } from './database-error';

// P 12.3 (PH3, decided by Hassan): a database error is reduced to its name, Prisma code,
// SQLSTATE and constraint name. Message, meta, cause, detail and parameters never survive.
// The shapes are the ones recorded on PostgreSQL 16 with Prisma 7.10 and the pg adapter.

const SECRET = 'SECRET VALUE 0001';

function knownRequestError(code: string, cause: Record<string, unknown>): Error {
  return new Prisma.PrismaClientKnownRequestError(`Invalid invocation with "${SECRET}"`, {
    code,
    clientVersion: '7.10.0',
    meta: { modelName: 'AuditLog', driverAdapterError: { name: 'DriverAdapterError', cause } },
  });
}

const CHECK_VIOLATION = knownRequestError('P2039', {
  originalCode: '23514',
  originalMessage:
    'new row for relation "audit_log" violates check constraint "audit_log_correlation_id_check"',
  kind: 'postgres',
  code: '23514',
  message:
    'new row for relation "audit_log" violates check constraint "audit_log_correlation_id_check"',
  detail: `Failing row contains (d183ab38, AU, mondapac, ${SECRET}).`,
});

const UNIQUE_VIOLATION = knownRequestError('P2002', {
  originalCode: '23505',
  originalMessage: 'duplicate key value violates unique constraint "audit_log_pkey"',
  kind: 'UniqueConstraintViolation',
  constraint: { index: 'audit_log_pkey' },
  table: 'audit_log',
});

const MALFORMED_ID = knownRequestError('P2007', {
  originalCode: '22P02',
  originalMessage: `invalid input syntax for type uuid: "${SECRET}"`,
  kind: 'InvalidInputValue',
  message: `invalid input syntax for type uuid: "${SECRET}"`,
});

describe('reduceDatabaseError (P 12.3)', () => {
  it('reduces a CHECK violation, whose detail holds the failing row', () => {
    const reduced = reduceDatabaseError(CHECK_VIOLATION);

    expect(reduced).toEqual({
      name: 'PrismaClientKnownRequestError',
      prismaCode: 'P2039',
      sqlState: '23514',
      constraint: 'audit_log_correlation_id_check',
    });
    expect(JSON.stringify(reduced)).not.toContain(SECRET);
  });

  it('reduces a unique violation to the constraint the driver names', () => {
    expect(reduceDatabaseError(UNIQUE_VIOLATION)).toEqual({
      name: 'PrismaClientKnownRequestError',
      prismaCode: 'P2002',
      sqlState: '23505',
      constraint: 'audit_log_pkey',
    });
  });

  it('reduces a malformed id, whose message quotes the input, to its codes', () => {
    const reduced = reduceDatabaseError(MALFORMED_ID);

    expect(reduced).toEqual({
      name: 'PrismaClientKnownRequestError',
      prismaCode: 'P2007',
      sqlState: '22P02',
    });
    expect(JSON.stringify(reduced)).not.toContain(SECRET);
  });

  it('reduces the bare DriverAdapterError of a conflict at COMMIT', () => {
    const error = Object.assign(new Error('TransactionWriteConflict'), {
      name: 'DriverAdapterError',
      cause: { originalCode: '40001', kind: 'TransactionWriteConflict', originalMessage: SECRET },
    });

    expect(reduceDatabaseError(error)).toEqual({ name: 'DriverAdapterError', sqlState: '40001' });
  });

  it('keeps only a constraint name that looks like an identifier', () => {
    const error = knownRequestError('P2002', {
      originalCode: '23505',
      constraint: { index: `x" ${SECRET}` },
    });

    expect(reduceDatabaseError(error)).toEqual({
      name: 'PrismaClientKnownRequestError',
      prismaCode: 'P2002',
      sqlState: '23505',
    });
  });

  it('answers undefined for an error that is not a database error', () => {
    expect(reduceDatabaseError(new TypeError(SECRET))).toBeUndefined();
    expect(reduceDatabaseError(SECRET)).toBeUndefined();
    expect(reduceDatabaseError(null)).toBeUndefined();
  });

  it('reduces the other Prisma errors to their name and code', () => {
    const timeout = new Prisma.PrismaClientKnownRequestError(SECRET, {
      code: 'P2028',
      clientVersion: '7.10.0',
    });
    const validation = new Prisma.PrismaClientValidationError(SECRET, { clientVersion: '7.10.0' });

    expect(reduceDatabaseError(timeout)).toEqual({
      name: 'PrismaClientKnownRequestError',
      prismaCode: 'P2028',
    });
    expect(reduceDatabaseError(validation)).toEqual({ name: 'PrismaClientValidationError' });
  });
});
