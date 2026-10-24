import { Prisma } from '../../generated/prisma/client';
import { classifyConflict } from './conflict-classifier';

// P 3.1 row 7 and the classifier row of P 13: the SQLSTATE is read in exactly two places,
// shaped as spike 6 recorded them (11-error-shapes.json, 12-error-at-commit.json).

function knownRequestError(code: string, originalCode?: string): Error {
  return new Prisma.PrismaClientKnownRequestError('a message that may quote values', {
    code,
    clientVersion: '7.10.0',
    meta:
      originalCode === undefined
        ? { modelName: 'AuditLog' }
        : {
            modelName: 'AuditLog',
            driverAdapterError: {
              name: 'DriverAdapterError',
              cause: { originalCode, originalMessage: 'm', kind: 'TransactionWriteConflict' },
            },
          },
  });
}

/** The bare error a conflict at COMMIT arrives as: no Prisma code, `meta` null. */
function driverAdapterError(originalCode: string): Error {
  const error = new Error('TransactionWriteConflict');
  error.name = 'DriverAdapterError';
  Object.assign(error, { meta: null, cause: { originalCode, kind: 'TransactionWriteConflict' } });
  return error;
}

describe('classifyConflict (P 3.1 row 7)', () => {
  it.each(['40001', '40P01'])('retries %s raised at a statement (P2034)', (code) => {
    expect(classifyConflict(knownRequestError('P2034', code))).toEqual({
      retry: true,
      sqlState: code,
    });
  });

  it.each(['40001', '40P01'])('retries %s raised at COMMIT (a bare DriverAdapterError)', (code) => {
    expect(classifyConflict(driverAdapterError(code))).toEqual({ retry: true, sqlState: code });
  });

  it('retries 40001 raised through raw SQL (P2010), by its SQLSTATE', () => {
    expect(classifyConflict(knownRequestError('P2010', '40001'))).toEqual({
      retry: true,
      sqlState: '40001',
    });
  });

  it('makes a lock timeout (55P03, as P2039) a conflict that is not retried', () => {
    expect(classifyConflict(knownRequestError('P2039', '55P03'))).toEqual({
      retry: false,
      sqlState: '55P03',
    });
  });

  it.each<[string, Error]>([
    ['P2034 with no SQLSTATE', knownRequestError('P2034')],
    ['P2002 (unique violation)', knownRequestError('P2002', '23505')],
    ['P2028 (transaction timeout)', knownRequestError('P2028')],
    ['08006 at COMMIT (connection failure)', driverAdapterError('08006')],
    ['57014 (statement timeout, P2010)', knownRequestError('P2010', '57014')],
  ])('is not a conflict: %s', (_case, error) => {
    expect(classifyConflict(error)).toBeNull();
  });

  it.each<[string, unknown]>([
    [
      '40001 in a nested cause off the two paths',
      Object.assign(new Error('wrapped'), { cause: driverAdapterError('40001') }),
    ],
    [
      '40001 under meta.cause instead of meta.driverAdapterError.cause',
      new Prisma.PrismaClientKnownRequestError('m', {
        code: 'P2034',
        clientVersion: '7.10.0',
        meta: { cause: { originalCode: '40001' } },
      }),
    ],
    ['a pg error with code 40001', Object.assign(new Error('pg'), { code: '40001' })],
    [
      'an object that only calls itself PrismaClientKnownRequestError',
      {
        name: 'PrismaClientKnownRequestError',
        code: 'P2034',
        meta: { driverAdapterError: { cause: { originalCode: '40001' } } },
      },
    ],
    ['a DriverAdapterError whose code is not a string', driverAdapterError(40001 as never)],
    ['null', null],
    ['a string', '40001'],
  ])('does not retry %s', (_case, error) => {
    expect(classifyConflict(error)).toBeNull();
  });
});
