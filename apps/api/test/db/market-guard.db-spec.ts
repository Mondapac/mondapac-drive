import { ok } from '@mondapac-drive/shared-kernel';
import { Client } from 'pg';
import { auditTx } from '../../src/platform/persistence/audit/audit-transaction';
import { AUDIT_PROPERTIES } from '../../src/platform/persistence/guarded-client';
import type { MarketContext } from '@mondapac-drive/shared-kernel';
import { MarketGuardError, NoUnitOfWorkError } from '../../src/platform/unit-of-work/errors';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  modelMap,
  otherMarketOf,
  randomUUID,
  type Persistence,
} from './persistence-support';
import { migrationDatabaseUrl, testDatabaseUrl } from './test-database';

// Platform persistence design ("P") 4 and the row "A query without the Market fails" of 13,
// for both Market fixtures, as the application role. Driven by the generated model map: a new
// scoped model is covered without a new test. Every refusal is checked by its error class,
// and "no row written" by a read on the base client.

type Delegate = Record<string, (args?: unknown) => Promise<unknown>>;

const scopedModels = Object.entries(modelMap.models).filter(
  ([, entry]) => entry.scope === 'scoped',
);
const RAW_METHODS = ['$queryRaw', '$executeRaw', '$queryRawUnsafe', '$executeRawUnsafe'] as const;

/** Calls a raw method the way its signature expects (tagged template or string). */
function callRaw(client: unknown, method: (typeof RAW_METHODS)[number]): Promise<unknown> {
  const target = client as Record<string, (...args: unknown[]) => Promise<unknown>>;
  if (method.endsWith('Unsafe')) return target[method]!('SELECT 1');
  const strings = Object.assign(['SELECT 1'], { raw: ['SELECT 1'] });
  return target[method]!(strings);
}

describe('market guard (database integration)', () => {
  let db: Persistence;

  beforeAll(() => {
    db = createPersistence();
  });

  afterAll(async () => {
    await db.close();
  });

  it('has the generated map of the real schema, with at least one scoped model', () => {
    expect(scopedModels.map(([name]) => name)).toContain('AuditLog');
  });

  describe.each(TEST_MARKETS)('in a unit for %s', (code) => {
    const market = marketOf(code);
    const other = otherMarketOf(code);

    describe.each(scopedModels)('scoped model %s', (_model, entry) => {
      const delegateIn = (tx: unknown) => (tx as Record<string, Delegate>)[entry.clientProperty]!;
      /** The audit models are only in the writer's view (Hassan M1 on slice 6a). */
      const viewOf = (market: MarketContext): unknown =>
        (AUDIT_PROPERTIES as readonly string[]).includes(entry.clientProperty)
          ? auditTx(market)
          : db.service.tx(market);
      const runWith = (call: (delegate: Delegate) => Promise<unknown>) =>
        db.unitOfWork.run(market, async () => {
          await call(delegateIn(viewOf(market)));
          return ok(undefined);
        });
      /** A row the guard must refuse before it reaches the database. */
      const draft = (overrides: Record<string, unknown>) => ({
        ...(entry.idField === null ? {} : { [entry.idField]: randomUUID() }),
        marketId: market.marketId,
        tenantId: market.tenantId,
        ...overrides,
      });
      const countById = (row: Record<string, unknown>) =>
        entry.idField === null
          ? Promise.resolve(0)
          : delegateIn(db.root).count!({ where: { [entry.idField]: row[entry.idField] } });

      it.each<[string, (delegate: Delegate) => Promise<unknown>, string]>([
        ['no where', (d) => d.findMany!(), 'where-missing'],
        ['a where without marketId', (d) => d.findMany!({ where: {} }), 'where-market-missing'],
        [
          "the other fixture's Market",
          (d) => d.findMany!({ where: { marketId: other } }),
          'where-market-mismatch',
        ],
        ['a count without marketId', (d) => d.count!({}), 'where-missing'],
        [
          'a deleteMany without marketId',
          (d) => d.deleteMany!({ where: {} }),
          'where-market-missing',
        ],
      ])('refuses a query with %s', async (_case, call, reason) => {
        const run = runWith(call);

        await expect(run).rejects.toBeInstanceOf(MarketGuardError);
        await expect(run).rejects.toMatchObject({ reason });
      });

      it.each([
        ['the other Market', { marketId: other }, 'data-market-mismatch'],
        ['another tenant', { tenantId: 'other-tenant' }, 'data-tenant-mismatch'],
      ])('refuses a create with %s and writes no row', async (_case, overrides, reason) => {
        const row = draft(overrides);
        // A model keyed by its Market (a counter, a version row) may already have a row for
        // the Market from another suite: the check is that the refusal adds none.
        const before = await countById(row);

        await expect(runWith((d) => d.create!({ data: row }))).rejects.toMatchObject({
          name: 'MarketGuardError',
          reason,
        });
        await expect(runWith((d) => d.createMany!({ data: [row] }))).rejects.toMatchObject({
          reason,
        });
        await expect(countById(row)).resolves.toBe(before);
      });

      it('refuses a nested write on every relation field (none yet on some models)', async () => {
        for (const relation of entry.relationFields) {
          const row = draft({ [relation]: { connect: { id: randomUUID() } } });
          const before = await countById(row);
          await expect(runWith((d) => d.create!({ data: row }))).rejects.toMatchObject({
            reason: 'nested-write',
          });
          await expect(countById(row)).resolves.toBe(before);
        }
      });

      it('refuses a query with no open unit, on the guarded client and through tx(market)', async () => {
        const guarded = delegateIn(db.client);

        await expect(
          guarded.findMany!({ where: { marketId: market.marketId } }),
        ).rejects.toMatchObject({ name: 'MarketGuardError', reason: 'no-open-unit' });
        expect(() => db.service.tx(market)).toThrow(NoUnitOfWorkError);
      });

      it('lets a query with the unit Market through, and returns rows of that Market only', async () => {
        const result = await db.unitOfWork.run(
          market,
          async () =>
            ok(
              (await delegateIn(viewOf(market)).findMany!({
                where: { marketId: market.marketId },
                take: 50,
              })) as { marketId: string }[],
            ),
          { readOnly: true },
        );

        expect(result.ok && result.value.every((row) => row.marketId === code)).toBe(true);
      });
    });

    describe('raw SQL (P 4.2): every raw method reaches the guard and is refused', () => {
      it.each(RAW_METHODS)(
        '%s on the guarded base client, with and without a unit',
        async (method) => {
          await expect(callRaw(db.client, method)).rejects.toMatchObject({
            name: 'MarketGuardError',
            reason: 'raw-sql',
          });
          const inUnit = db.unitOfWork.run(
            market,
            async () => ok(await callRaw(db.client, method)),
            { readOnly: true },
          );
          await expect(inUnit).rejects.toMatchObject({ reason: 'raw-sql' });
        },
      );

      it.each(RAW_METHODS)(
        '%s on an interactive-transaction client of the guarded client',
        async (method) => {
          const run = db.client.$transaction(async (tx) => callRaw(tx, method));

          await expect(run).rejects.toMatchObject({ name: 'MarketGuardError', reason: 'raw-sql' });
        },
      );

      it('$queryRawTyped is refused (by Prisma itself while the typedSql preview is off)', async () => {
        const client = db.client as unknown as { $queryRawTyped(sql: unknown): Promise<unknown> };

        await expect(client.$queryRawTyped({ sql: 'SELECT 1', values: [] })).rejects.toBeInstanceOf(
          Error,
        );
      });
    });
  });
});

describe('PM6: a child row cannot name a parent of another Market (database)', () => {
  // Mandatory for every in-module foreign key between scoped tables (P 11, PM6). The guard
  // cannot check a scalar foreign key in `data`, so the key itself carries market_id.

  it('every foreign key of the map between scoped models includes market_id, aligned', async () => {
    // Map-driven, on the catalog: for each such key, the constraint pairs market_id with
    // market_id. There is no such key before identity's tables; the test-only pair below
    // proves the behaviour until then.
    const keys = Object.entries(modelMap.models).flatMap(([name, entry]) =>
      entry.foreignKeys
        .filter(() => entry.scope === 'scoped')
        .filter((fk) => modelMap.models[fk.target]?.scope === 'scoped')
        .map((fk) => ({ name, entry, fk })),
    );
    const sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
    try {
      for (const { entry, fk } of keys) {
        const { rows } = await sql.query<{ pairs: string[] }>(
          `SELECT array_agg(a.attname || '>' || r.attname ORDER BY k.n) AS pairs
             FROM pg_constraint c
             CROSS JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(child, parent, n)
             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.child
             JOIN pg_attribute r ON r.attrelid = c.confrelid AND r.attnum = k.parent
            WHERE c.contype = 'f'
              AND c.conrelid = format('%I.%I', $1::text, $2::text)::regclass
              AND c.confrelid = format('%I.%I', $1::text, $3::text)::regclass
            GROUP BY c.oid`,
          [entry.schema, entry.table, fk.targetTable],
        );
        const expected = fk.columns.map(
          (column, index) => `${column}>${fk.referencedColumns[index]}`,
        );
        expect(rows.map((row) => row.pairs)).toContainEqual(expected);
        expect(expected).toContain('market_id>market_id');
      }
    } finally {
      await sql.end();
    }
  });

  describe('on a test-only parent and child pair with a composite key', () => {
    const name = `pm6_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    let admin: Client;
    let app: Client;

    beforeAll(async () => {
      // A database of its own, created and owned by the migration role, so the privilege and
      // catalog tests of the run database never see these tables.
      admin = new Client({ connectionString: migrationDatabaseUrl() });
      await admin.connect();
      await admin.query(`CREATE DATABASE "${name}"`);
      await admin.query(`REVOKE ALL ON DATABASE "${name}" FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE "${name}" TO "drive_app"`);
      const ownerUrl = new URL(migrationDatabaseUrl());
      ownerUrl.pathname = `/${name}`;
      const owner = new Client({ connectionString: ownerUrl.toString() });
      await owner.connect();
      await owner.query(`
        CREATE SCHEMA pm6;
        GRANT USAGE ON SCHEMA pm6 TO drive_app;
        CREATE TABLE pm6.parent (
          id uuid PRIMARY KEY,
          market_id varchar(8) NOT NULL,
          tenant_id text NOT NULL,
          UNIQUE (market_id, id));
        CREATE TABLE pm6.child (
          id uuid PRIMARY KEY,
          market_id varchar(8) NOT NULL,
          tenant_id text NOT NULL,
          parent_id uuid NOT NULL,
          FOREIGN KEY (market_id, parent_id) REFERENCES pm6.parent (market_id, id));
        GRANT SELECT, INSERT ON pm6.parent, pm6.child TO drive_app;
        GRANT UPDATE (parent_id) ON pm6.child TO drive_app;`);
      await owner.end();
      const appUrl = new URL(testDatabaseUrl());
      appUrl.pathname = `/${name}`;
      app = new Client({ connectionString: appUrl.toString() });
      await app.connect();
    });

    afterAll(async () => {
      // beforeAll may have failed before connecting; the scratch database is dropped anyway.
      await (app as Client | undefined)?.end();
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.end();
    });

    const parent = async (marketId: string) => {
      const id = randomUUID();
      await app.query('INSERT INTO pm6.parent (id, market_id, tenant_id) VALUES ($1, $2, $3)', [
        id,
        marketId,
        'mondapac',
      ]);
      return id;
    };
    const children = async (id: string) =>
      Number(
        (await app.query<{ count: string }>('SELECT count(*) FROM pm6.child WHERE id = $1', [id]))
          .rows[0]!.count,
      );

    it.each(TEST_MARKETS)(
      'in a %s unit, a create and an update naming the other fixture parent are refused (23503)',
      async (code) => {
        const own = await parent(code);
        const foreign = await parent(otherMarketOf(code));
        const childId = randomUUID();

        await expect(
          app.query(
            'INSERT INTO pm6.child (id, market_id, tenant_id, parent_id) VALUES ($1, $2, $3, $4)',
            [childId, code, 'mondapac', foreign],
          ),
        ).rejects.toMatchObject({ code: '23503' });
        await expect(children(childId)).resolves.toBe(0);

        await app.query(
          'INSERT INTO pm6.child (id, market_id, tenant_id, parent_id) VALUES ($1, $2, $3, $4)',
          [childId, code, 'mondapac', own],
        );
        await expect(
          app.query('UPDATE pm6.child SET parent_id = $1 WHERE id = $2', [foreign, childId]),
        ).rejects.toMatchObject({ code: '23503' });
        const { rows } = await app.query('SELECT parent_id FROM pm6.child WHERE id = $1', [
          childId,
        ]);
        expect(rows).toEqual([{ parent_id: own }]);
      },
    );
  });
});
