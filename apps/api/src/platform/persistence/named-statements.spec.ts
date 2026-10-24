import { testMarketContext } from '@mondapac-drive/shared-kernel/testing';
import { Prisma } from '../../generated/prisma/client';
import { NamedStatementRefusedError } from '../unit-of-work/errors';
import {
  isApprovedStatement,
  lockStockItemsStatement,
  lockTimeoutStatement,
  MAX_LOCKED_STOCK_ITEMS,
  runNamedStatement,
  type RawRunner,
} from './named-statements';

// P 4.2: the closed list of named raw statements, with a fake runner (no database). The
// statement text is read from the Sql object the runner receives.

const ID = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function runnerAnswering(rows: unknown[]) {
  const seen: Prisma.Sql[] = [];
  const runner: RawRunner = {
    query: (statement) => {
      seen.push(statement);
      return Promise.resolve(rows);
    },
    execute: () => Promise.resolve(0),
  };
  return { runner, seen };
}

const rowOf = (id: string) => ({
  id,
  offer_id: ID(900),
  variant_id: ID(901),
  source_id: ID(902),
  seller_id: ID(903),
  on_hand: 4,
  retired_at: null,
  version: 2,
});

describe.each(['AU', 'ZZ'] as const)('inventory.lock-stock-items in market %s', (code) => {
  const market = testMarketContext(code, 'mondapac');

  it('binds the unit’s Market and tenant first, never the caller’s, and locks in id order', async () => {
    const { runner, seen } = runnerAnswering([rowOf(ID(1)), rowOf(ID(2))]);

    const rows = await runNamedStatement(runner, market, 'inventory.lock-stock-items', {
      ids: [ID(2), ID(1), ID(2)],
    });

    expect(rows.map((row) => row.id)).toEqual([ID(1), ID(2)]);
    expect(rows[0]).toEqual({
      id: ID(1),
      offerId: ID(900),
      variantId: ID(901),
      sourceId: ID(902),
      sellerId: ID(903),
      onHand: 4,
      retiredAt: null,
      version: 2,
    });
    expect(seen).toHaveLength(1);
    const statement = seen[0]!;
    expect(isApprovedStatement({ operation: '$queryRaw', args: statement }, market)).toBe(true);
    expect(statement.values).toEqual([market.marketId, market.tenantId, [ID(2), ID(1)]]);
    expect(statement.sql).toMatch(
      /s\.market_id = \?\s+AND s\.tenant_id = \?\s+AND s\.id = ANY\(\?::uuid\[\]\)/u,
    );
    expect(statement.sql).toMatch(/ORDER BY s\.id\s+FOR NO KEY UPDATE OF s$/u);
  });

  it.each([
    ['ids-empty', []],
    ['ids-too-many', Array.from({ length: MAX_LOCKED_STOCK_ITEMS + 1 }, (_, n) => ID(n + 1))],
    ['ids-malformed', ['not-a-uuid']],
    ['ids-malformed', ['ABCDEF00-0000-4000-8000-000000000001']],
    ['ids-malformed', [`${ID(1)}'; DROP TABLE x; --`]],
    ['ids-malformed', [42 as never]],
  ])('refuses the input %s before any statement is sent', async (reason, ids) => {
    const { runner, seen } = runnerAnswering([]);

    await expect(
      runNamedStatement(runner, market, 'inventory.lock-stock-items', { ids }),
    ).rejects.toEqual(
      new NamedStatementRefusedError('inventory.lock-stock-items', reason as never),
    );
    expect(seen).toHaveLength(0);
  });

  it('refuses a list that is not an array', async () => {
    const { runner } = runnerAnswering([]);
    await expect(
      runNamedStatement(runner, market, 'inventory.lock-stock-items', { ids: 'x' as never }),
    ).rejects.toEqual(
      new NamedStatementRefusedError('inventory.lock-stock-items', 'ids-malformed'),
    );
  });

  it('accepts exactly the cap, counting duplicates once', async () => {
    const ids = Array.from({ length: MAX_LOCKED_STOCK_ITEMS }, (_, n) => ID(n + 1));
    const { runner } = runnerAnswering(ids.map(rowOf));

    const rows = await runNamedStatement(runner, market, 'inventory.lock-stock-items', {
      ids: [...ids, ID(1)],
    });

    expect(rows).toHaveLength(MAX_LOCKED_STOCK_ITEMS);
  });

  it('fails when fewer rows come back than distinct ids (another Market’s id, or a bug)', async () => {
    const { runner } = runnerAnswering([rowOf(ID(1))]);

    await expect(
      runNamedStatement(runner, market, 'inventory.lock-stock-items', { ids: [ID(1), ID(2)] }),
    ).rejects.toEqual(new NamedStatementRefusedError('inventory.lock-stock-items', 'rows-missing'));
  });

  it('does not put an id in the error', async () => {
    const { runner } = runnerAnswering([]);
    let message = '';
    try {
      await runNamedStatement(runner, market, 'inventory.lock-stock-items', { ids: [ID(7)] });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(ID(7));
  });
});

describe.each(['AU', 'ZZ'] as const)(
  'the guard’s recognition of raw statements, unit of %s',
  (code) => {
    const market = testMarketContext(code, 'mondapac');
    const otherCode = code === 'AU' ? 'ZZ' : 'AU';
    const lock = (marketId: string, tenantId: string) =>
      lockStockItemsStatement({ marketId, tenantId } as never, [ID(1)]);

    it('recognises the lock statement only with the unit’s Market and tenant', () => {
      const own = lock(market.marketId, market.tenantId);
      expect(isApprovedStatement({ operation: '$queryRaw', args: own }, market)).toBe(true);
      for (const forged of [lock(otherCode, market.tenantId), lock(market.marketId, 'other')]) {
        expect(isApprovedStatement({ operation: '$queryRaw', args: forged }, market)).toBe(false);
      }
    });

    it('recognises each text for its own operation only', () => {
      const own = lock(market.marketId, market.tenantId);
      const timeout = lockTimeoutStatement(100);
      expect(isApprovedStatement({ operation: '$executeRaw', args: own }, market)).toBe(false);
      expect(isApprovedStatement({ operation: '$queryRaw', args: timeout }, market)).toBe(false);
      expect(isApprovedStatement({ operation: '$executeRaw', args: timeout }, market)).toBe(true);
      for (const operation of ['$queryRawUnsafe', '$executeRawUnsafe', '$queryRawTyped']) {
        expect(isApprovedStatement({ operation, args: own }, market)).toBe(false);
        expect(isApprovedStatement({ operation, args: timeout }, market)).toBe(false);
      }
    });

    it.each([
      "SET LOCAL lock_timeout = '3001ms'",
      "SET LOCAL lock_timeout = '0ms'",
      "SET LOCAL lock_timeout = '100ms'; SELECT 1",
      "SET LOCAL statement_timeout = '100ms'",
      "SET lock_timeout = '100ms'",
      'SELECT 1',
    ])('refuses the text %s', (text) => {
      expect(
        isApprovedStatement({ operation: '$executeRaw', args: Prisma.raw(text) }, market),
      ).toBe(false);
    });

    it('refuses the lock text with changed SQL or an extra parameter', () => {
      const own = lock(market.marketId, market.tenantId);
      const altered = Prisma.raw(own.sql.replace('FOR NO KEY UPDATE', 'FOR UPDATE'));
      expect(isApprovedStatement({ operation: '$queryRaw', args: altered }, market)).toBe(false);
      expect(
        isApprovedStatement(
          { operation: '$queryRaw', args: { sql: own.sql, values: [...own.values, 'x'] } },
          market,
        ),
      ).toBe(false);
    });

    it.each([null, undefined, 'SELECT 1', 42, [], {}, { sql: 1, values: [] }])(
      'refuses the argument %j',
      (args) => {
        expect(isApprovedStatement({ operation: '$queryRaw', args }, market)).toBe(false);
        expect(isApprovedStatement({ operation: '$executeRaw', args }, market)).toBe(false);
      },
    );
  },
);

describe('lockTimeoutStatement', () => {
  it('builds the fixed text with the checked number', () => {
    const statement = lockTimeoutStatement(250);
    expect(statement.sql).toBe("SET LOCAL lock_timeout = '250ms'");
  });

  it.each([0, -1, 3001, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses %s, because SET takes no parameter and the number is part of the text',
    (milliseconds) => {
      expect(() => lockTimeoutStatement(milliseconds)).toThrow(RangeError);
    },
  );
});

describe('certification.share-pending-submission', () => {
  const market = testMarketContext('AU', 'default');
  const other = testMarketContext('ZZ', 'default');

  it('shares the root of a pending submission in the unit Market only', async () => {
    const { runner, seen } = runnerAnswering([{ id: ID(9) }]);
    const rows = await runNamedStatement(runner, market, 'certification.share-pending-submission', {
      submissionId: ID(1),
    });
    expect(rows).toEqual([{ certificateId: ID(9) }]);
    expect(seen[0]!.sql).toContain('FOR SHARE OF c');
    expect(seen[0]!.values).toEqual([market.marketId, market.tenantId, ID(1)]);
    const request = { operation: '$queryRaw', args: seen[0] };
    expect(isApprovedStatement(request, market)).toBe(true);
    expect(isApprovedStatement(request, other)).toBe(false);
  });

  it('refuses a malformed submission id', async () => {
    const { runner } = runnerAnswering([]);
    await expect(
      runNamedStatement(runner, market, 'certification.share-pending-submission', {
        submissionId: 'x; DROP TABLE',
      }),
    ).rejects.toBeInstanceOf(NamedStatementRefusedError);
  });
});

describe.each(['AU', 'ZZ'] as const)(
  'certification.share-type and certification.share-issuer in market %s',
  (code) => {
    const market = testMarketContext(code, 'default');
    const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');

    it('shares a type row in the unit Market only and answers its status', async () => {
      const { runner, seen } = runnerAnswering([{ status: 'inactive' }]);
      const rows = await runNamedStatement(runner, market, 'certification.share-type', {
        typeId: ID(3),
      });
      expect(rows).toEqual([{ status: 'inactive' }]);
      expect(seen[0]!.sql).toContain('FOR SHARE OF t');
      expect(seen[0]!.values).toEqual([market.marketId, market.tenantId, ID(3)]);
      const request = { operation: '$queryRaw', args: seen[0] };
      expect(isApprovedStatement(request, market)).toBe(true);
      expect(isApprovedStatement(request, other)).toBe(false);
    });

    it('shares an issuer row in the unit Market only and answers its state and type', async () => {
      const { runner, seen } = runnerAnswering([{ state: 'closed-to-new', type_id: ID(3) }]);
      const rows = await runNamedStatement(runner, market, 'certification.share-issuer', {
        issuerId: ID(4),
      });
      expect(rows).toEqual([{ state: 'closed-to-new', typeId: ID(3) }]);
      expect(seen[0]!.sql).toContain('FOR SHARE OF i');
      expect(seen[0]!.values).toEqual([market.marketId, market.tenantId, ID(4)]);
      const request = { operation: '$queryRaw', args: seen[0] };
      expect(isApprovedStatement(request, market)).toBe(true);
      expect(isApprovedStatement(request, other)).toBe(false);
    });

    it('refuses a malformed id', async () => {
      const { runner } = runnerAnswering([]);
      await expect(
        runNamedStatement(runner, market, 'certification.share-type', { typeId: 'x' }),
      ).rejects.toBeInstanceOf(NamedStatementRefusedError);
      await expect(
        runNamedStatement(runner, market, 'certification.share-issuer', { issuerId: '1 OR 1=1' }),
      ).rejects.toBeInstanceOf(NamedStatementRefusedError);
    });
  },
);
