import { Logger } from '@nestjs/common';
import { testMarketContext } from '@mondapac-drive/shared-kernel/testing';
import { MarketMismatchError, NoUnitOfWorkError } from '../../unit-of-work/errors';
import type { PrismaRoot } from '../prisma-root';
import { OpenUnit, unitStorage } from '../unit-store';
import { RawReadFailedError, RawReadRefusedError } from './errors';
import { bindRawReadParams, PrismaRawReadPort } from './prisma-raw-read-port';
import type { RawReadEntry } from './statements';

// The runtime half of ADR-0030 decisions 1, 5, 7 and 8 against a fake base client: what the port
// refuses before the database, what it sends, and what it logs.

const UUID_A = '0192b3c4-0000-7000-8000-000000000001';
const UUID_B = '0192b3c4-0000-7000-8000-000000000002';

const entry: RawReadEntry<{ id: string }> = {
  id: 'delivery.test-read',
  owner: 'delivery',
  reason: 'test',
  design: 'test',
  sql: 'SELECT 1',
  params: [
    { name: 'ids', type: 'uuid[]', maxLength: 2, group: 'zip' },
    { name: 'codes', type: 'text[]', maxLength: 2, group: 'zip' },
    { name: 'one', type: 'text' },
  ],
  parseRow: (row) => {
    const id = (row as { id?: unknown }).id;
    if (typeof id !== 'string') throw new Error('bad row secret-value');
    return { id };
  },
};

const market = testMarketContext('AU', 'default');
const otherMarket = testMarketContext('ZZ', 'default');
const good = { ids: [UUID_A], codes: ['halal'], one: 'x' };

function fakeRoot(answer: unknown): { root: PrismaRoot; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const root = {
    $queryRawUnsafe: (...args: unknown[]) => {
      calls.push(args);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  } as unknown as PrismaRoot;
  return { root, calls };
}

const inUnit = <T>(readOnly: boolean, work: () => Promise<T>, unitMarket = market): Promise<T> => {
  const unit = new OpenUnit(unitMarket, readOnly, {}, {});
  return unitStorage.run(unit, work);
};

const read = (port: PrismaRawReadPort, id: string, params: unknown = good) =>
  (port.rawRead as (m: unknown, id: string, p: unknown) => Promise<unknown[]>)(market, id, params);

describe('PrismaRawReadPort', () => {
  let logged: unknown[];
  beforeEach(() => {
    logged = [];
    for (const method of ['log', 'error'] as const) {
      jest.spyOn(Logger.prototype, method).mockImplementation((...args: unknown[]) => {
        logged.push(args[0]);
      });
    }
  });
  afterEach(() => jest.restoreAllMocks());

  it('sends the listed text with the unit Market as $1 and the bound values, in a read-only unit', async () => {
    const { root, calls } = fakeRoot([{ id: 'r1' }]);
    const port = new PrismaRawReadPort(root, [entry]);
    const rows = await inUnit(true, () => read(port, entry.id));
    expect(rows).toEqual([{ id: 'r1' }]);
    expect(calls).toEqual([['SELECT 1', 'AU', [UUID_A], ['halal'], 'x']]);
  });

  it("binds a port to one module: another module's statement is refused before any unit or database (Hassan R-1)", async () => {
    const { root, calls } = fakeRoot([{ id: 'r1' }]);
    const port = new PrismaRawReadPort(root, [entry]);
    const other = port.forModule('catalog');
    const call = (p: { rawRead: unknown }, id: string) =>
      (p.rawRead as (m: unknown, id: string, params: unknown) => Promise<unknown[]>)(
        market,
        id,
        good,
      );
    await expect(inUnit(true, () => call(other, entry.id))).rejects.toMatchObject({
      reason: 'wrong-module',
    });
    await expect(call(other, entry.id)).rejects.toMatchObject({ reason: 'wrong-module' });
    await expect(inUnit(true, () => call(other, 'catalog.unknown'))).rejects.toMatchObject({
      reason: 'unknown-statement',
    });
    expect(calls).toEqual([]);
    await expect(inUnit(true, () => call(port.forModule('delivery'), entry.id))).resolves.toEqual([
      { id: 'r1' },
    ]);
  });

  it('refuses with no open unit, a closed unit, a read-write unit and another Market', async () => {
    const { root, calls } = fakeRoot([]);
    const port = new PrismaRawReadPort(root, [entry]);
    await expect(read(port, entry.id)).rejects.toBeInstanceOf(NoUnitOfWorkError);
    const unit = new OpenUnit(market, true, {}, {});
    unit.close();
    await expect(unitStorage.run(unit, () => read(port, entry.id))).rejects.toBeInstanceOf(
      NoUnitOfWorkError,
    );
    await expect(inUnit(false, () => read(port, entry.id))).rejects.toMatchObject({
      reason: 'read-write-unit',
    });
    await expect(inUnit(true, () => read(port, entry.id), otherMarket)).rejects.toBeInstanceOf(
      MarketMismatchError,
    );
    expect(calls).toEqual([]);
  });

  it('refuses an unknown id without touching the database', async () => {
    const { root, calls } = fakeRoot([]);
    const port = new PrismaRawReadPort(root, [entry]);
    await expect(inUnit(true, () => read(port, 'delivery.nope'))).rejects.toMatchObject({
      reason: 'unknown-statement',
    });
    expect(calls).toEqual([]);
  });

  it('fails a row that does not fit the schema, logging the id and never the row', async () => {
    const { root } = fakeRoot([{ id: 'r1' }, { id: 42, secret: 'secret-value' }]);
    const port = new PrismaRawReadPort(root, [entry]);
    await expect(inUnit(true, () => read(port, entry.id))).rejects.toMatchObject({
      reason: 'row-invalid',
    });
    expect(JSON.stringify(logged)).toContain('delivery.test-read');
    expect(JSON.stringify(logged)).not.toContain('secret-value');
  });

  it('rethrows a database error as its SQLSTATE only and logs no parameter value', async () => {
    const failure = Object.assign(new Error('relation "x" has value halal-secret'), {
      code: '57014',
    });
    const { root } = fakeRoot(failure);
    const port = new PrismaRawReadPort(root, [entry]);
    const error = await inUnit(true, () => read(port, entry.id)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RawReadFailedError);
    expect((error as Error).message).not.toContain('halal-secret');
    expect(JSON.stringify(logged)).not.toContain('halal-secret');
    expect(JSON.stringify(logged)).not.toContain(UUID_A);
  });

  it('refuses a result that is not an array', async () => {
    const { root } = fakeRoot({ not: 'rows' });
    const port = new PrismaRawReadPort(root, [entry]);
    await expect(inUnit(true, () => read(port, entry.id))).rejects.toMatchObject({
      reason: 'not-an-array',
    });
  });

  it('logs the id, module, Market, row count and duration on success, and no value', async () => {
    const { root } = fakeRoot([{ id: 'r1' }]);
    const port = new PrismaRawReadPort(root, [entry]);
    await inUnit(true, () => read(port, entry.id));
    expect(logged).toEqual([
      expect.objectContaining({
        msg: 'raw-read.done',
        statement: entry.id,
        module: 'delivery',
        marketId: 'AU',
        rows: 1,
      }),
    ]);
    expect(JSON.stringify(logged)).not.toContain(UUID_A);
  });
});

describe('bindRawReadParams', () => {
  const refusal = (params: unknown): string | undefined => {
    try {
      bindRawReadParams(entry, params);
      return undefined;
    } catch (error) {
      return error instanceof RawReadRefusedError ? error.reason : 'other';
    }
  };

  it('binds the declared parameters in order', () => {
    expect(bindRawReadParams(entry, good)).toEqual([[UUID_A], ['halal'], 'x']);
  });

  it.each([
    ['a caller-supplied Market', { ...good, marketId: 'ZZ' }, 'params-malformed'],
    ['a missing parameter', { ids: [UUID_A], codes: ['a'] }, 'params-malformed'],
    ['a non-object', 'x', 'params-malformed'],
    ['an array', [], 'params-malformed'],
    ['a scalar for an array', { ...good, ids: UUID_A }, 'params-malformed'],
    ['an array for a scalar', { ...good, one: ['x'] }, 'params-malformed'],
    ['a malformed uuid', { ...good, ids: ['not-a-uuid'] }, 'params-malformed'],
    ['a non-string text element', { ...good, codes: [1] }, 'params-malformed'],
    ['a text with a NUL', { ...good, one: 'a\u0000b' }, 'params-malformed'],
    [
      'an array over its cap',
      { ...good, ids: [UUID_A, UUID_B, UUID_A], codes: ['a', 'b'] },
      'array-too-long',
    ],
    [
      'zipped arrays of unequal length',
      { ...good, ids: [UUID_A, UUID_B], codes: ['a'] },
      'group-length-mismatch',
    ],
  ])('refuses %s', (_name, params, reason) => {
    expect(refusal(params)).toBe(reason);
  });
});
