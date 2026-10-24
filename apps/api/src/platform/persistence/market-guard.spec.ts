import { testMarketContext } from '@mondapac-drive/shared-kernel/testing';
import type { MarketGuardRefusal } from '../unit-of-work/errors';
import { Prisma } from '../../generated/prisma/client';
import { marketGuardRefusal, type GuardUnit } from './market-guard';
import { lockStockItemsStatement, lockTimeoutStatement } from './named-statements';
import type { ModelMap, ModelMapEntry } from './model-map';

// P 4.1 and the first row of P 13: the guard's decision as a pure function of (map entry,
// operation, arguments, open unit), for both Market fixtures. No database, no Nest.

const TENANT = 'mondapac';
const OTHER_TENANT = 'other-tenant';

function entry(overrides: Partial<ModelMapEntry>): ModelMapEntry {
  return {
    module: 'alpha',
    schema: 'alpha',
    table: 't',
    clientProperty: 'x',
    scope: 'scoped',
    scalarFields: ['id', 'marketId', 'tenantId'],
    relationFields: [],
    idField: 'id',
    compoundSelectors: [],
    foreignKeys: [],
    ...overrides,
  };
}

const MAP: ModelMap = {
  models: {
    AuditLog: entry({
      module: 'platform',
      scalarFields: ['id', 'marketId', 'tenantId', 'action', 'targetId'],
    }),
    // The throttle shape of identity's data design: a compound @@id that contains marketId.
    Throttle: entry({
      scalarFields: ['marketId', 'tenantId', 'kind', 'keyHash', 'attempts'],
      idField: null,
      compoundSelectors: [
        { name: 'marketId_kind_keyHash', fields: ['marketId', 'kind', 'keyHash'] },
      ],
    }),
    // Every kind of compound selector: the composite key children point at, a `name:`-named
    // one, one whose marketId is not the leading field, one with the tenant, one without the
    // Market (the schema check refuses that on a scoped model; the guard still reads it).
    Parent: entry({
      scalarFields: ['id', 'marketId', 'tenantId', 'code', 'kind', 'slug'],
      relationFields: ['children'],
      compoundSelectors: [
        { name: 'marketId_id', fields: ['marketId', 'id'] },
        { name: 'byCode', fields: ['marketId', 'code'] },
        { name: 'kind_marketId', fields: ['kind', 'marketId'] },
        { name: 'marketId_tenantId_slug', fields: ['marketId', 'tenantId', 'slug'] },
      ],
    }),
    Child: entry({
      scalarFields: ['id', 'marketId', 'tenantId', 'parentId'],
      relationFields: ['parent'],
    }),
    Lookup: entry({ scope: 'exempt', scalarFields: ['code', 'label'], idField: 'code' }),
  },
  modules: {},
};

describe.each(['AU', 'ZZ'] as const)('market guard decision, unit opened for %s', (code) => {
  const market = testMarketContext(code, TENANT);
  const other = code === 'AU' ? 'ZZ' : 'AU';
  const M = market.marketId as string;
  const unit: GuardUnit = { market, readOnly: false, closed: false };
  const readOnlyUnit: GuardUnit = { market, readOnly: true, closed: false };
  const row = (extra: Record<string, unknown> = {}) => ({
    marketId: M,
    tenantId: TENANT,
    ...extra,
  });

  const decide = (
    model: string | undefined,
    operation: string,
    args: unknown,
    open: GuardUnit | 'no unit' = unit,
  ): MarketGuardRefusal | null =>
    marketGuardRefusal(MAP, { model, operation, args }, open === 'no unit' ? undefined : open);

  describe('the open unit (P 4.1 last rows; ADR-0025 condition (a))', () => {
    it('refuses any model operation with no open unit', () => {
      expect(decide('AuditLog', 'findMany', { where: { marketId: M } }, 'no unit')).toBe(
        'no-open-unit',
      );
    });

    it('refuses a query that meets a closed unit', () => {
      expect(
        decide('AuditLog', 'findMany', { where: { marketId: M } }, { ...unit, closed: true }),
      ).toBe('unit-closed');
    });

    it('refuses a model the map does not know', () => {
      expect(decide('Unknown', 'findMany', { where: { marketId: M } })).toBe('unknown-model');
    });

    it.each(['aggregateRaw', 'findRaw', 'runCommandRaw', 'somethingNew', 'createOne'])(
      'refuses the unrecognised operation %s',
      (operation) => {
        expect(decide('AuditLog', operation, { where: { marketId: M } })).toBe('unknown-operation');
      },
    );

    it.each(['$queryRaw', '$executeRaw', '$queryRawUnsafe', '$executeRawUnsafe', '$queryRawTyped'])(
      'refuses raw SQL (%s), inside a unit and outside one',
      (operation) => {
        expect(decide(undefined, operation, {})).toBe('raw-sql');
        expect(decide(undefined, operation, {}, 'no unit')).toBe('raw-sql');
      },
    );

    describe('named statements (P 4.2)', () => {
      const lock = (marketId: string, tenantId: string) =>
        lockStockItemsStatement({ marketId, tenantId } as never, [
          '00000000-0000-4000-8000-000000000001',
        ]);
      const own = lock(M, TENANT);
      const timeout = lockTimeoutStatement(100);

      it('lets the lock statement through $queryRaw and the timeout through $executeRaw', () => {
        expect(decide(undefined, '$queryRaw', own)).toBeNull();
        expect(decide(undefined, '$executeRaw', timeout)).toBeNull();
      });

      it('refuses the lock statement for another Market or tenant than the unit’s', () => {
        expect(decide(undefined, '$queryRaw', lock(other, TENANT))).toBe('raw-sql');
        expect(decide(undefined, '$queryRaw', lock(M, OTHER_TENANT))).toBe('raw-sql');
      });

      it('refuses a text that is not on the list, and the other operation for a listed text', () => {
        expect(decide(undefined, '$queryRaw', Prisma.sql`SELECT 1`)).toBe('raw-sql');
        expect(decide(undefined, '$executeRaw', own)).toBe('raw-sql');
        expect(decide(undefined, '$queryRaw', timeout)).toBe('raw-sql');
        expect(decide(undefined, '$executeRaw', Prisma.raw('SET LOCAL lock_timeout = 5000'))).toBe(
          'raw-sql',
        );
      });

      it.each(['$queryRawUnsafe', '$executeRawUnsafe', '$queryRawTyped'])(
        'refuses %s even with a listed statement',
        (operation) => {
          expect(decide(undefined, operation, own)).toBe('raw-sql');
          expect(decide(undefined, operation, timeout)).toBe('raw-sql');
        },
      );

      it('refuses a listed statement with no unit, in a read-only unit and in a closed one', () => {
        expect(decide(undefined, '$queryRaw', own, 'no unit')).toBe('raw-sql');
        expect(decide(undefined, '$queryRaw', own, readOnlyUnit)).toBe('raw-sql');
        expect(decide(undefined, '$queryRaw', own, { ...unit, closed: true })).toBe('raw-sql');
      });
    });

    it('refuses any other client operation with no model', () => {
      expect(decide(undefined, '$somethingNew', {})).toBe('unknown-operation');
    });

    it('needs an open unit for an exempt model too', () => {
      expect(decide('Lookup', 'findMany', {}, 'no unit')).toBe('no-open-unit');
      expect(decide('Lookup', 'findMany', {})).toBeNull();
    });
  });

  describe('where: top-level marketId equal to the unit Market (P 4.1 row 1)', () => {
    const READS = [
      'findUnique',
      'findUniqueOrThrow',
      'findFirst',
      'findFirstOrThrow',
      'findMany',
      'count',
      'aggregate',
      'groupBy',
    ];
    const WRITES = ['update', 'updateMany', 'updateManyAndReturn', 'delete', 'deleteMany'];

    // An update also needs its data; it is checked in its own describe below.
    const withData = (operation: string, where: unknown) =>
      operation.startsWith('update') ? { where, data: { action: 'a.b.c' } } : { where };

    it.each([...READS, ...WRITES])('%s: accepts the plain value and { equals }', (operation) => {
      expect(decide('AuditLog', operation, withData(operation, { marketId: M, id: 'x' }))).toBe(
        null,
      );
      expect(decide('AuditLog', operation, withData(operation, { marketId: { equals: M } }))).toBe(
        null,
      );
    });

    it.each([...READS, ...WRITES])('%s: refuses no where and a where without marketId', (op) => {
      expect(decide('AuditLog', op, {})).toBe('where-missing');
      expect(decide('AuditLog', op, undefined)).toBe('where-missing');
      expect(decide('AuditLog', op, { where: { id: 'x' } })).toBe('where-market-missing');
    });

    it.each([...READS, ...WRITES])("%s: refuses the other fixture's Market", (op) => {
      expect(decide('AuditLog', op, { where: { marketId: other } })).toBe('where-market-mismatch');
    });

    it.each([
      ['{ equals, mode }', { equals: M, mode: 'insensitive' }],
      ['{ in }', { in: [M] }],
      ['{ not }', { not: other }],
      ['{ equals } of the other Market', { equals: other }],
      ['null', null],
      ['undefined', undefined],
      ['an array', [M]],
      ['a number', 61],
    ])('refuses marketId as %s', (_case, value) => {
      expect(decide('AuditLog', 'findMany', { where: { marketId: value } })).not.toBeNull();
    });

    it.each([
      ['OR', { OR: [{ marketId: M }] }],
      ['NOT', { NOT: { marketId: other } }],
      ['AND', { AND: [{ marketId: M }] }],
    ])('does not count marketId inside %s', (_case, where) => {
      expect(decide('AuditLog', 'findMany', { where })).toBe('where-market-missing');
    });

    it('accepts AND, OR and NOT beside the top-level marketId', () => {
      expect(
        decide('AuditLog', 'findMany', {
          where: { marketId: M, AND: [{ action: 'a.b.c' }], OR: [{ id: 'x' }], NOT: { id: 'y' } },
        }),
      ).toBeNull();
    });

    it('accepts a read by id that names the Market, and refuses one that does not', () => {
      expect(decide('AuditLog', 'findUnique', { where: { id: 'x', marketId: M } })).toBeNull();
      expect(decide('AuditLog', 'findUnique', { where: { id: 'x' } })).toBe('where-market-missing');
    });

    it('refuses an unknown top-level where key', () => {
      expect(decide('AuditLog', 'findMany', { where: { marketId: M, nonsense: 1 } })).toBe(
        'where-unknown-key',
      );
      expect(decide('AuditLog', 'findMany', { where: { marketId: M, market_id: M } })).toBe(
        'where-unknown-key',
      );
    });

    it('accepts a relation field as a where key (a nested read filter)', () => {
      expect(
        decide('Parent', 'findMany', { where: { marketId: M, children: { some: { id: 'c' } } } }),
      ).toBeNull();
    });

    it('accepts nested reads: include and select', () => {
      expect(
        decide('Parent', 'findMany', {
          where: { marketId: M },
          include: { children: true },
          select: { id: true },
        }),
      ).toBeNull();
    });

    it('refuses a where that is not an object', () => {
      expect(decide('AuditLog', 'findMany', { where: 'marketId' })).toBe('where-missing');
      expect(decide('AuditLog', 'findMany', { where: [{ marketId: M }] })).toBe('where-missing');
    });
  });

  describe('compound unique selectors (P 4.1 row 2)', () => {
    const selector = { marketId: M, kind: 'sign-in', keyHash: 'h' };

    it('refuses a compound selector alone, without the top-level marketId', () => {
      expect(decide('Throttle', 'findUnique', { where: { marketId_kind_keyHash: selector } })).toBe(
        'where-market-missing',
      );
    });

    it('accepts the unit Market in both the selector and the top level', () => {
      expect(
        decide('Throttle', 'findUnique', {
          where: { marketId: M, marketId_kind_keyHash: selector },
        }),
      ).toBeNull();
    });

    it('refuses the other Market in the selector beside the unit Market at the top level', () => {
      expect(
        decide('Throttle', 'findUnique', {
          where: { marketId: M, marketId_kind_keyHash: { ...selector, marketId: other } },
        }),
      ).toBe('selector-market-mismatch');
    });

    it.each([
      ['missing', { kind: 'sign-in', keyHash: 'h' }],
      ['undefined', { marketId: undefined, kind: 'sign-in', keyHash: 'h' }],
      ['null', { marketId: null, kind: 'sign-in', keyHash: 'h' }],
      ['{ equals }', { marketId: { equals: M }, kind: 'sign-in', keyHash: 'h' }],
      ['another object (a FieldRef stand-in)', { marketId: { name: 'marketId', modelName: 'T' } }],
    ])('refuses the selector marketId %s', (_case, value) => {
      expect(
        decide('Throttle', 'findUnique', { where: { marketId: M, marketId_kind_keyHash: value } }),
      ).toBe('selector-market-mismatch');
    });

    it('refuses a selector value that is not an object', () => {
      expect(
        decide('Throttle', 'findUnique', { where: { marketId: M, marketId_kind_keyHash: 'x' } }),
      ).toBe('selector-malformed');
    });

    it('reads a `name:`-named selector and one whose marketId is not the leading field', () => {
      for (const name of ['byCode', 'kind_marketId']) {
        const ok = { marketId: M, code: 'c', kind: 'k' };
        expect(decide('Parent', 'findUnique', { where: { marketId: M, [name]: ok } })).toBeNull();
        expect(
          decide('Parent', 'findUnique', {
            where: { marketId: M, [name]: { ...ok, marketId: other } },
          }),
        ).toBe('selector-market-mismatch');
      }
    });

    it('refuses another tenant in a selector that contains tenantId', () => {
      const value = { marketId: M, tenantId: TENANT, slug: 's' };
      expect(
        decide('Parent', 'findUnique', { where: { marketId: M, marketId_tenantId_slug: value } }),
      ).toBeNull();
      expect(
        decide('Parent', 'findUnique', {
          where: { marketId: M, marketId_tenantId_slug: { ...value, tenantId: OTHER_TENANT } },
        }),
      ).toBe('selector-tenant-mismatch');
    });

    it('refuses the database name of a selector (only Prisma names are where keys)', () => {
      expect(
        decide('Parent', 'findUnique', {
          where: { marketId: M, alpha_parent_code_key: { marketId: M, code: 'c' } },
        }),
      ).toBe('where-unknown-key');
    });
  });

  describe('cursor: the unit Market, like a where (Hassan, L1)', () => {
    const read = (cursor: unknown, model = 'AuditLog', operation = 'findMany') =>
      decide(model, operation, { where: { marketId: M }, cursor, take: 10 });

    it.each(['findMany', 'findFirst', 'findFirstOrThrow'])(
      '%s: accepts a cursor that names the unit Market',
      (operation) => {
        expect(read({ id: 'i', marketId: M }, 'AuditLog', operation)).toBeNull();
        expect(read({ id: 'i', marketId: { equals: M } }, 'AuditLog', operation)).toBeNull();
      },
    );

    it('lets a read without a cursor, or with an undefined one, through', () => {
      expect(decide('AuditLog', 'findMany', { where: { marketId: M } })).toBeNull();
      expect(read(undefined)).toBeNull();
    });

    it('refuses a cursor without marketId, by id alone', () => {
      expect(read({ id: 'i' })).toBe('cursor-market-missing');
    });

    it("refuses a cursor that names the other fixture's Market", () => {
      expect(read({ id: 'i', marketId: other })).toBe('cursor-market-mismatch');
      expect(read({ id: 'i', marketId: { in: [M, other] } })).toBe('cursor-market-mismatch');
    });

    it('refuses a cursor that is not an object, or that has an unknown key', () => {
      expect(read('i')).toBe('cursor-malformed');
      expect(read(null)).toBe('cursor-malformed');
      expect(read({ id: 'i', marketId: M, market_id: M })).toBe('cursor-unknown-key');
    });

    it('reads the compound selectors of a cursor', () => {
      const selector = { marketId: M, kind: 'sign-in', keyHash: 'h' };
      expect(read({ marketId: M, marketId_kind_keyHash: selector }, 'Throttle')).toBeNull();
      expect(read({ marketId_kind_keyHash: selector }, 'Throttle')).toBe('cursor-market-missing');
      expect(
        read({ marketId: M, marketId_kind_keyHash: { ...selector, marketId: other } }, 'Throttle'),
      ).toBe('selector-market-mismatch');
    });

    it('checks the where before the cursor', () => {
      expect(
        decide('AuditLog', 'findMany', { where: { marketId: other }, cursor: { id: 'i' } }),
      ).toBe('where-market-mismatch');
    });

    it('lets a cursor on an exempt model through', () => {
      expect(decide('Lookup', 'findMany', { cursor: { code: 'c' } })).toBeNull();
    });
  });

  describe('create, createMany, createManyAndReturn (P 4.1 row 4)', () => {
    it.each(['create', 'createMany', 'createManyAndReturn'])('%s: accepts own rows', (op) => {
      const data = op === 'create' ? row() : [row({ id: 'a' }), row({ id: 'b' })];
      expect(decide('AuditLog', op, { data })).toBeNull();
    });

    it('accepts a single object for createMany, as Prisma does', () => {
      expect(decide('AuditLog', 'createMany', { data: row() })).toBeNull();
    });

    it.each(['create', 'createMany', 'createManyAndReturn'])(
      '%s: refuses the other Market, another tenant and a missing pair',
      (op) => {
        const wrap = (value: unknown) => (op === 'create' ? value : [row(), value]);
        expect(decide('AuditLog', op, { data: wrap(row({ marketId: other })) })).toBe(
          'data-market-mismatch',
        );
        expect(decide('AuditLog', op, { data: wrap(row({ tenantId: OTHER_TENANT })) })).toBe(
          'data-tenant-mismatch',
        );
        expect(decide('AuditLog', op, { data: wrap({ id: 'x' }) })).toBe('data-market-mismatch');
        expect(decide('AuditLog', op, { data: wrap({ marketId: M }) })).toBe(
          'data-tenant-mismatch',
        );
      },
    );

    it('refuses no data', () => {
      expect(decide('AuditLog', 'create', {})).toBe('data-missing');
      expect(decide('AuditLog', 'createMany', { data: [] })).toBe('data-missing');
    });

    it.each(['create', 'connect', 'connectOrCreate', 'createMany'])(
      'refuses a nested write (%s) in create and in every createMany row',
      (nested) => {
        const data = row({ children: { [nested]: { id: 'c' } } });
        expect(decide('Parent', 'create', { data })).toBe('nested-write');
        expect(decide('Parent', 'createMany', { data: [row(), data] })).toBe('nested-write');
        expect(decide('Parent', 'createManyAndReturn', { data: [data] })).toBe('nested-write');
      },
    );

    it('refuses a nested create that carries the other Market', () => {
      expect(
        decide('Child', 'create', {
          data: row({ parent: { create: { marketId: other, tenantId: TENANT } } }),
        }),
      ).toBe('nested-write');
    });

    it('lets a scalar foreign key through (PM6: the database refuses the wrong parent)', () => {
      expect(decide('Child', 'create', { data: row({ parentId: 'p' }) })).toBeNull();
    });
  });

  describe('update, updateMany, updateManyAndReturn (P 4.1 rows 6 and 7)', () => {
    it.each(['update', 'updateMany', 'updateManyAndReturn'])(
      '%s: data never sets marketId or tenantId, even to the same values',
      (op) => {
        const where = { marketId: M, id: 'x' };
        expect(decide('AuditLog', op, { where, data: { action: 'a.b.c' } })).toBeNull();
        expect(decide('AuditLog', op, { where, data: { marketId: other } })).toBe(
          'data-changes-market',
        );
        expect(decide('AuditLog', op, { where, data: { marketId: M } })).toBe(
          'data-changes-market',
        );
        expect(decide('AuditLog', op, { where, data: { tenantId: { set: TENANT } } })).toBe(
          'data-changes-market',
        );
      },
    );

    it.each(['connect', 'connectOrCreate', 'create', 'update', 'disconnect', 'set'])(
      'refuses a nested write (%s) in update',
      (nested) => {
        expect(
          decide('Parent', 'update', {
            where: { marketId: M, id: 'p' },
            data: { children: { [nested]: { id: 'c' } } },
          }),
        ).toBe('nested-write');
      },
    );

    it('refuses an update with no data', () => {
      expect(decide('AuditLog', 'update', { where: { marketId: M, id: 'x' } })).toBe(
        'data-missing',
      );
    });
  });

  describe('upsert (P 4.1 rows 5 to 7)', () => {
    const where = { marketId: M, marketId_kind_keyHash: { marketId: M, kind: 'k', keyHash: 'h' } };
    const create = row({ kind: 'k', keyHash: 'h', attempts: 1 });
    const update = { attempts: { increment: 1 } };

    it('accepts an upsert by the compound @@id with the top-level marketId', () => {
      expect(decide('Throttle', 'upsert', { where, create, update })).toBeNull();
    });

    it('refuses the compound selector alone and the other Market in it', () => {
      expect(
        decide('Throttle', 'upsert', {
          where: { marketId_kind_keyHash: where.marketId_kind_keyHash },
          create,
          update,
        }),
      ).toBe('where-market-missing');
      expect(
        decide('Throttle', 'upsert', {
          where: { ...where, marketId_kind_keyHash: { marketId: other, kind: 'k', keyHash: 'h' } },
          create,
          update,
        }),
      ).toBe('selector-market-mismatch');
    });

    it('refuses an upsert by the single-column id, alone and beside a valid compound selector', () => {
      const parentWhere = { marketId: M, marketId_id: { marketId: M, id: 'p' } };
      expect(
        decide('Parent', 'upsert', { where: { marketId: M, id: 'p' }, create: row(), update: {} }),
      ).toBe('upsert-by-id');
      expect(
        decide('Parent', 'upsert', {
          where: { ...parentWhere, id: 'p' },
          create: row(),
          update: {},
        }),
      ).toBe('upsert-by-id');
      expect(decide('Parent', 'upsert', { where: parentWhere, create: row(), update: {} })).toBe(
        null,
      );
    });

    it('refuses an upsert with no compound selector that contains marketId', () => {
      expect(
        decide('Throttle', 'upsert', { where: { marketId: M, kind: 'k' }, create, update }),
      ).toBe('upsert-without-market-selector');
    });

    it('checks the create branch like a create', () => {
      expect(
        decide('Throttle', 'upsert', { where, create: { ...create, marketId: other }, update }),
      ).toBe('data-market-mismatch');
      expect(
        decide('Throttle', 'upsert', {
          where,
          create: { ...create, tenantId: OTHER_TENANT },
          update,
        }),
      ).toBe('data-tenant-mismatch');
    });

    it('checks the update branch like an update', () => {
      expect(decide('Throttle', 'upsert', { where, create, update: { marketId: other } })).toBe(
        'data-changes-market',
      );
    });

    it.each(['connect', 'connectOrCreate', 'create'])(
      'refuses a nested write (%s) in both branches',
      (nested) => {
        const parentWhere = { marketId: M, marketId_id: { marketId: M, id: 'p' } };
        const nestedWrite = { children: { [nested]: { id: 'c' } } };
        expect(
          decide('Parent', 'upsert', { where: parentWhere, create: row(nestedWrite), update: {} }),
        ).toBe('nested-write');
        expect(
          decide('Parent', 'upsert', { where: parentWhere, create: row(), update: nestedWrite }),
        ).toBe('nested-write');
      },
    );
  });

  describe('a read-only unit (ADR-0025)', () => {
    it.each(['findUnique', 'findFirst', 'findMany', 'count', 'aggregate', 'groupBy'])(
      'accepts the read %s',
      (op) => {
        expect(decide('AuditLog', op, { where: { marketId: M } }, readOnlyUnit)).toBeNull();
      },
    );

    it.each([
      ['create', { data: row() }],
      ['createMany', { data: [row()] }],
      ['createManyAndReturn', { data: [row()] }],
      ['update', { where: { marketId: M, id: 'x' }, data: { action: 'a.b.c' } }],
      ['updateMany', { where: { marketId: M }, data: { action: 'a.b.c' } }],
      ['updateManyAndReturn', { where: { marketId: M }, data: { action: 'a.b.c' } }],
      ['delete', { where: { marketId: M, id: 'x' } }],
      ['deleteMany', { where: { marketId: M } }],
      ['upsert', { where: { marketId: M }, create: row(), update: {} }],
    ])('refuses the write %s', (op, args) => {
      expect(decide('AuditLog', op, args, readOnlyUnit)).toBe('write-in-read-only-unit');
    });

    it("refuses a read for the other fixture's Market", () => {
      expect(decide('AuditLog', 'findMany', { where: { marketId: other } }, readOnlyUnit)).toBe(
        'where-market-mismatch',
      );
    });
  });

  describe('an exempt model', () => {
    it('reads and writes without the Market, but still refuses a write in a read-only unit', () => {
      expect(decide('Lookup', 'findUnique', { where: { code: 'c' } })).toBeNull();
      expect(decide('Lookup', 'create', { data: { code: 'c', label: 'l' } })).toBeNull();
      expect(decide('Lookup', 'create', { data: { code: 'c' } }, readOnlyUnit)).toBe(
        'write-in-read-only-unit',
      );
    });
  });
});
