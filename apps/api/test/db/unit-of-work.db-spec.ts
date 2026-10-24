import { setTimeout as sleep } from 'node:timers/promises';
import { Controller, Get, Inject } from '@nestjs/common';
import { err, ok } from '@mondapac-drive/shared-kernel';
import type { MarketContext } from '@mondapac-drive/shared-kernel';
import { Client } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { databaseIsolationAccepted } from '../../src/check-database-role';
import { Market } from '../../src/platform/market-context/market.decorator';
import { auditTx } from '../../src/platform/persistence/audit/audit-transaction';
import { DatabaseProbe } from '../../src/platform/persistence/database-probe';
import { GUARDED_OPERATIONS } from '../../src/platform/persistence/market-guard';
import { PrismaRoot } from '../../src/platform/persistence/prisma-root';
import {
  InvalidUnitOfWorkOptionsError,
  MarketGuardError,
  MarketMismatchError,
  NestedUnitOfWorkError,
  NoUnitOfWorkError,
  TransactionConflictError,
  UnmintedMarketContextError,
} from '../../src/platform/unit-of-work/errors';
import {
  CONNECTION_WAIT_MS,
  UNIT_OF_WORK,
  type UnitOfWork,
  type UnitOfWorkOptions,
} from '../../src/platform/unit-of-work/unit-of-work';
import { createTestApp } from '../support/test-app';
import { testAppConfig, TEST_MARKETS } from '../support/test-config';
import {
  auditRow,
  createPersistence,
  gate,
  holdRetriesUntil,
  marketOf,
  modelMap,
  otherMarketOf,
  randomUUID,
  recordDriverStatements,
  timed,
  type Persistence,
  type PersistenceOptions,
} from './persistence-support';
import {
  lockingOwnerTestDatabaseUrl,
  lockingTestDatabaseUrl,
  migrationDatabaseUrl,
  testDatabaseUrl,
} from './test-database';

// Platform persistence design ("P") 3 and the UnitOfWork and read-only rows of 13, with
// ADR-0025 conditions (a) to (e), for both Market fixtures. Everything runs as the
// application role on the run's locking database, a copy of the run database that only this
// file uses: it locks platform.audit_log and adds test-only triggers to it, created by the
// migration role (the owner) and dropped after, so no other file meets those locks.

const onLockingDatabase = (options: PersistenceOptions = {}): Persistence =>
  createPersistence({ databaseUrl: lockingTestDatabaseUrl(), ...options });

/** Audit actions the test-only triggers below turn into a serialisation failure. */
const CONFLICT_AT_STATEMENT = 'test.conflict.at-statement';
const CONFLICT_AT_COMMIT = 'test.conflict.at-commit';

const TEST_ONLY_TRIGGERS = `
CREATE FUNCTION platform.zz_test_raise_serialization_failure() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'test-only serialization failure' USING ERRCODE = '40001';
END $$;
CREATE TRIGGER zz_test_conflict_at_statement BEFORE INSERT ON platform.audit_log
  FOR EACH ROW WHEN (NEW.action = '${CONFLICT_AT_STATEMENT}')
  EXECUTE FUNCTION platform.zz_test_raise_serialization_failure();
CREATE CONSTRAINT TRIGGER zz_test_conflict_at_commit AFTER INSERT ON platform.audit_log
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.action = '${CONFLICT_AT_COMMIT}')
  EXECUTE FUNCTION platform.zz_test_raise_serialization_failure();`;

const DROP_TEST_ONLY_TRIGGERS = `
DROP TRIGGER IF EXISTS zz_test_conflict_at_commit ON platform.audit_log;
DROP TRIGGER IF EXISTS zz_test_conflict_at_statement ON platform.audit_log;
DROP FUNCTION IF EXISTS platform.zz_test_raise_serialization_failure();`;

/** Unit work with nothing to await; a throw inside it becomes a rejection, as in async work. */
const inline =
  <T>(work: () => T): (() => Promise<T>) =>
  () =>
    Promise.resolve().then(work);

/** The first words of a statement: its kind, without its tables, columns or parameters. */
const statementKind = (sql: string): string =>
  /^SET TRANSACTION ISOLATION LEVEL [A-Z ]+$/i.test(sql.trim())
    ? sql.trim().toUpperCase()
    : (/^\s*(\w+)/.exec(sql)?.[1]?.toUpperCase() ?? '');

describe('UnitOfWork (database integration)', () => {
  let db: Persistence;
  let driver: ReturnType<typeof recordDriverStatements>;
  let owner: Client;
  /** A separate application-role connection: reads pg_stat_activity of the role's sessions. */
  let observer: Client;

  beforeAll(async () => {
    driver = recordDriverStatements();
    db = onLockingDatabase();
    owner = new Client({ connectionString: lockingOwnerTestDatabaseUrl() });
    await owner.connect();
    await owner.query(TEST_ONLY_TRIGGERS);
    observer = new Client({ connectionString: lockingTestDatabaseUrl() });
    await observer.connect();
  });

  afterAll(async () => {
    await owner.query(DROP_TEST_ONLY_TRIGGERS);
    await owner.end();
    await observer.end();
    await db.close();
    driver.restore();
  });

  /** Whether a row exists, read on the base client outside any unit. */
  const rowExists = async (id: string) => (await db.root.auditLog.count({ where: { id } })) === 1;

  const insert = (market: MarketContext, row: ReturnType<typeof auditRow>) =>
    auditTx(market).auditLog.create({ data: row });

  describe.each(TEST_MARKETS)('in a unit for %s', (code) => {
    const market = marketOf(code);
    const other = marketOf(otherMarketOf(code));

    describe('commit rule (P 3.1 row 3)', () => {
      it('commits an ok result', async () => {
        const row = auditRow(market);

        const result = await db.unitOfWork.run(market, async () => {
          await insert(market, row);
          return ok('saved');
        });

        expect(result).toEqual({ ok: true, value: 'saved' });
        await expect(rowExists(row.id)).resolves.toBe(true);
      });

      it('commits nothing for an err result and returns it unchanged', async () => {
        const row = auditRow(market);
        const refusal = { code: 'test.refused' } as const;

        const result = await db.unitOfWork.run(market, async () => {
          await insert(market, row);
          return err(refusal);
        });

        expect(result).toEqual({ ok: false, error: refusal });
        await expect(rowExists(row.id)).resolves.toBe(false);
      });

      it('commits nothing when work throws, and rethrows the error', async () => {
        const row = auditRow(market);
        const failure = new Error('work failed');

        const run = db.unitOfWork.run(market, async () => {
          await insert(market, row);
          throw failure;
        });

        await expect(run).rejects.toBe(failure);
        await expect(rowExists(row.id)).resolves.toBe(false);
      });

      it('runs a read-write unit in one transaction, invisible outside before commit (row 1)', async () => {
        // Raw SQL is refused in a unit, so pg_backend_pid() cannot be read; the unit's own
        // uncommitted row is visible to its later statements and to no one else.
        const row = auditRow(market);
        const seen: boolean[] = [];

        await db.unitOfWork.run(market, async () => {
          await insert(market, row);
          const tx = auditTx(market);
          seen.push(
            (await tx.auditLog.count({ where: { marketId: market.marketId, id: row.id } })) === 1,
          );
          seen.push(await rowExists(row.id));
          return ok(undefined);
        });

        // Inside the unit the row is visible to the unit and to no one else before commit.
        expect(seen).toEqual([true, false]);
      });
    });

    describe('the open unit and its Market (P 3.1 rows 2 and 4, 3.3)', () => {
      it('refuses a MarketContext that was not minted', async () => {
        const forged = { marketId: market.marketId, tenantId: market.tenantId } as MarketContext;

        await expect(db.unitOfWork.run(forged, () => Promise.resolve(ok(1)))).rejects.toThrow(
          UnmintedMarketContextError,
        );
      });

      it("refuses the other fixture's context in this unit (tx(market) mismatch)", async () => {
        const run = db.unitOfWork.run(
          market,
          inline(() => {
            db.service.tx(other);
            return ok(undefined);
          }),
        );

        await expect(run).rejects.toThrow(MarketMismatchError);
      });

      it('throws NoUnitOfWorkError for tx(market) with no open unit', () => {
        expect(() => db.service.tx(market)).toThrow(NoUnitOfWorkError);
      });

      it.each<[UnitOfWorkOptions, UnitOfWorkOptions]>([
        [{}, {}],
        [{}, { readOnly: true }],
        [{ readOnly: true }, {}],
        [{ readOnly: true }, { readOnly: true }],
      ])('throws NestedUnitOfWorkError for a unit %j inside a unit %j', async (inner, outer) => {
        const row = auditRow(market);
        const run = db.unitOfWork.run(
          market,
          async () => {
            await db.unitOfWork.run(market, () => Promise.resolve(ok(undefined)), inner);
            if (!outer.readOnly) await insert(market, row);
            return ok(undefined);
          },
          outer,
        );

        await expect(run).rejects.toThrow(NestedUnitOfWorkError);
        await expect(rowExists(row.id)).resolves.toBe(false);
      });

      it('refuses a query started inside a read-write unit and awaited after it ends', async () => {
        const row = auditRow(market);
        let late: Promise<unknown> | undefined;

        await db.unitOfWork.run(
          market,
          inline(() => {
            late = auditTx(market).auditLog.create({ data: row });
            return ok(undefined);
          }),
        );

        await expect(late).rejects.toThrow(MarketGuardError);
        await expect(rowExists(row.id)).resolves.toBe(false);
      });
    });

    describe('isolation (P 3.1 row 6, ADR-0025 decision 2)', () => {
      it('sends no SET TRANSACTION for a default unit, and Serializable when asked', async () => {
        const read = async () => {
          await auditTx(market).auditLog.count({
            where: { marketId: market.marketId, targetId: 'isolation' },
          });
          return ok(undefined);
        };

        await driver.during(() => db.unitOfWork.run(market, read));
        const defaultUnit = [...driver.statements];
        await driver.during(() => db.unitOfWork.run(market, read, { isolation: 'serializable' }));
        const serializableUnit = [...driver.statements];

        expect(defaultUnit.map(statementKind)).toEqual(['BEGIN', 'SELECT', 'COMMIT']);
        expect(serializableUnit.map(statementKind)).toEqual([
          'BEGIN',
          'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE',
          'SELECT',
          'COMMIT',
        ]);
      });

      it('runs a default transaction at read committed, as the application role', async () => {
        // Raw SQL is refused inside a unit, so the level is read through a probe on the base
        // client with the same pool and role, in a transaction opened the way `run` opens one.
        const rows = await db.root.$transaction(
          (tx) =>
            tx.$queryRaw<{ level: string; role: string }[]>`
              SELECT current_setting('transaction_isolation') AS level, current_user AS role`,
        );

        expect(rows).toEqual([{ level: 'read committed', role: 'drive_api' }]);
      });
    });

    describe('retry (P 3.1 row 7)', () => {
      it('runs two serialisable units in conflict to success, one of them retried once', async () => {
        // The loser retries only once the winner has settled, so the retry reads the committed
        // row. A fixed pause raced a slow commit on a busy runner and cost a fourth attempt.
        const retrying = onLockingDatabase();
        const oneSettled = gate();
        const restorePause = holdRetriesUntil(retrying.unitOfWork, oneSettled.opened);
        const targetId = `write-skew-${randomUUID()}`;
        const bothRead = gate();
        let reads = 0;
        let attempts = 0;
        const unit = () =>
          retrying.unitOfWork.run(
            market,
            async () => {
              attempts += 1;
              const tx = auditTx(market);
              const seen = await tx.auditLog.count({
                where: { marketId: market.marketId, targetId },
              });
              reads += 1;
              if (reads === 2) bothRead.open();
              // Only the first attempts wait for each other; a retry runs straight through.
              if (reads <= 2) await bothRead.opened;
              await tx.auditLog.create({ data: auditRow(market, { targetId, after: { seen } }) });
              return ok(seen);
            },
            { isolation: 'serializable' },
          );

        const settles = () => unit().finally(() => oneSettled.open());
        const results = await Promise.all([settles(), settles()]).finally(() => {
          restorePause();
          return retrying.close();
        });

        expect(results.map((r) => r.ok && r.value).sort()).toEqual([0, 1]);
        expect(attempts).toBe(3);
        await expect(
          db.root.auditLog.count({ where: { marketId: market.marketId, targetId } }),
        ).resolves.toBe(2);
      });

      it.each([
        ['at a statement', CONFLICT_AT_STATEMENT],
        ['at COMMIT', CONFLICT_AT_COMMIT],
      ])(
        'ends a 40001 raised on every attempt %s after exactly 3 attempts, committing nothing',
        async (_where, action) => {
          const pauses: number[] = [];
          const retrying = onLockingDatabase({
            pause: (attempt) => {
              pauses.push(attempt);
              return Promise.resolve();
            },
          });
          const ids: string[] = [];
          try {
            const run = retrying.unitOfWork.run(market, async () => {
              const row = auditRow(market, { action });
              ids.push(row.id);
              await auditTx(market).auditLog.create({ data: row });
              return ok(undefined);
            });

            await expect(run).rejects.toEqual(new TransactionConflictError('40001'));
            await expect(run).rejects.toMatchObject({ sqlState: '40001' });
          } finally {
            await retrying.close();
          }
          expect(ids).toHaveLength(3);
          expect(pauses).toEqual([1, 2]);
          for (const id of ids) await expect(rowExists(id)).resolves.toBe(false);
        },
      );

      it('turns a lock timeout (55P03) into TransactionConflictError after one attempt', async () => {
        // The login role's lock_timeout (3 s, PK1) is a deployment setting; this pool sets a
        // shorter one on its own sessions only, so the test does not wait 3 s.
        const locked = onLockingDatabase({ urlParameters: { options: '-c lock_timeout=300' } });
        let attempts = 0;
        await owner.query('BEGIN');
        try {
          await owner.query('LOCK TABLE platform.audit_log IN ACCESS EXCLUSIVE MODE');
          const run = locked.unitOfWork.run(market, async () => {
            attempts += 1;
            await auditTx(market).auditLog.create({ data: auditRow(market) });
            return ok(undefined);
          });

          await expect(run).rejects.toEqual(new TransactionConflictError('55P03'));
        } finally {
          await owner.query('ROLLBACK');
          await locked.close();
        }
        expect(attempts).toBe(1);
      });

      it('does not retry or convert a unique violation (P2002)', async () => {
        const row = auditRow(market);
        let attempts = 0;
        const run = db.unitOfWork.run(market, async () => {
          attempts += 1;
          await insert(market, row);
          await insert(market, { ...row });
          return ok(undefined);
        });

        await expect(run).rejects.toMatchObject({ code: 'P2002' });
        expect(attempts).toBe(1);
        await expect(rowExists(row.id)).resolves.toBe(false);
      });
    });

    describe('timeouts (P 3.1 row 8)', () => {
      it('rolls back a unit that outlives its timeout', async () => {
        const row = auditRow(market);
        const run = db.unitOfWork.run(
          market,
          async () => {
            await insert(market, row);
            await sleep(700);
            return ok(undefined);
          },
          { timeoutMs: 300 },
        );

        await expect(run).rejects.toMatchObject({ code: 'P2028' });
        await expect(rowExists(row.id)).resolves.toBe(false);
      });

      it.each([{ readOnly: false }, { readOnly: true }])(
        'fails within about 2 s when the pool is exhausted (%j)',
        async (options) => {
          // The application's own wait, not the harness's longer one.
          const small = onLockingDatabase({
            env: { DATABASE_POOL_MAX: '1' },
            connectionWaitMs: CONNECTION_WAIT_MS,
          });
          const holding = gate();
          const held = gate();
          const holder = small.unitOfWork.run(market, async () => {
            await auditTx(market).auditLog.count({ where: { marketId: market.marketId } });
            held.open();
            await holding.opened;
            return ok(undefined);
          });
          try {
            await held.opened;
            const waiting = timed(
              small.unitOfWork.run(
                market,
                async () =>
                  ok(
                    await auditTx(market).auditLog.count({ where: { marketId: market.marketId } }),
                  ),
                options,
              ),
            );
            const outcome = await waiting;

            expect(outcome.error).toBeDefined();
            expect(outcome.ms).toBeGreaterThan(1500);
            expect(outcome.ms).toBeLessThan(5000);
          } finally {
            holding.open();
            await holder;
            await small.close();
          }
        },
        10_000,
      );
    });

    describe('the view tx(market) hands out (ADR-0025 condition (b); Hassan, H1)', () => {
      const CLIENT_MEMBERS = [
        '$transaction',
        '$queryRaw',
        '$executeRaw',
        '$queryRawUnsafe',
        '$executeRawUnsafe',
        '$queryRawTyped',
        '$connect',
        '$disconnect',
        '$on',
        '$extends',
      ];

      /**
       * Every property name reachable from `start` through own data properties and
       * prototypes, `depth` steps deep. Getters are not called.
       */
      function reachableNames(start: unknown, depth: number): Set<string> {
        const names = new Set<string>();
        const seen = new Set<unknown>();
        let level: unknown[] = [start];
        for (let step = 0; step <= depth && level.length > 0; step += 1) {
          const next: unknown[] = [];
          for (const value of level) {
            if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
              continue;
            }
            if (seen.has(value)) continue;
            seen.add(value);
            next.push(Object.getPrototypeOf(value));
            for (const key of Reflect.ownKeys(value)) {
              names.add(String(key));
              const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
              if (descriptor !== undefined && 'value' in descriptor) next.push(descriptor.value);
            }
          }
          level = next;
        }
        return names;
      }

      const auditProperties = ['auditChainCheckpoint', 'auditLog', 'auditLogSeal'];
      const moduleProperties = Object.values(modelMap.models)
        .map((entry) => entry.clientProperty)
        .filter((property) => !auditProperties.includes(property))
        .sort();

      it.each([
        ['a read-write unit', 'tx', {}],
        ['a read-only unit', 'tx', { readOnly: true }],
        ['a read-write unit', 'auditTx', {}],
        ['a read-only unit', 'auditTx', { readOnly: true }],
      ] as [string, 'tx' | 'auditTx', UnitOfWorkOptions][])(
        'in %s, %s: frozen, no prototype, the guarded operations only, no way to the client',
        async (_case, which, options) => {
          let view: unknown;
          await db.unitOfWork.run(
            market,
            inline(() => {
              view = which === 'tx' ? db.service.tx(market) : auditTx(market);
              return ok(undefined);
            }),
            options,
          );
          if (typeof view !== 'object' || view === null) throw new Error('no view');

          expect(Object.isFrozen(view)).toBe(true);
          expect(Object.getPrototypeOf(view)).toBeNull();
          // tx(market): one delegate per model of the map except the audit models (Hassan M1
          // on slice 6a), the outbox models included, which only platform/persistence/outbox/
          // may name (pnpm boundaries). auditTx(market): the audit models and nothing else.
          expect([...Reflect.ownKeys(view)].sort()).toEqual(
            which === 'tx' ? moduleProperties : auditProperties,
          );
          for (const member of CLIENT_MEMBERS) expect(member in view).toBe(false);

          const delegate = Reflect.get(view, which === 'tx' ? 'subjectKey' : 'auditLog') as Record<
            string,
            unknown
          >;
          expect(Object.isFrozen(delegate)).toBe(true);
          expect(Object.getPrototypeOf(delegate)).toBeNull();
          expect([...Reflect.ownKeys(delegate)].sort()).toEqual([...GUARDED_OPERATIONS].sort());
          for (const member of ['$parent', '$name', 'fields', ...CLIENT_MEMBERS]) {
            expect(member in delegate).toBe(false);
          }
          for (const operation of GUARDED_OPERATIONS) {
            expect(typeof delegate[operation]).toBe('function');
          }

          const reachable = reachableNames(view, 6);
          expect(reachable.has('findMany')).toBe(true);
          for (const member of ['$parent', '$queryRawUnsafe', '$transaction', '$disconnect']) {
            expect(reachable.has(member)).toBe(false);
          }
          if (which === 'tx') {
            for (const property of auditProperties) expect(reachable.has(property)).toBe(false);
          }
        },
      );

      it('auditTx(market) has the checks of tx(market): no unit, and the other Market', async () => {
        expect(() => auditTx(market)).toThrow(NoUnitOfWorkError);
        const run = db.unitOfWork.run(
          market,
          inline(() => {
            auditTx(other);
            return ok(undefined);
          }),
        );

        await expect(run).rejects.toThrow(MarketMismatchError);
      });

      it('the operations of the view still reach the database through the guard', async () => {
        const row = auditRow(market);
        await db.unitOfWork.run(market, async () => {
          await insert(market, row);
          return ok(undefined);
        });

        const found = await db.unitOfWork.run(
          market,
          async () =>
            ok(
              await auditTx(market).auditLog.findMany({
                where: { marketId: market.marketId, id: row.id },
              }),
            ),
          { readOnly: true },
        );
        expect(found.ok && found.value.map((r) => r.id)).toEqual([row.id]);
        await expect(
          db.unitOfWork.run(
            market,
            async () => ok(await auditTx(market).auditLog.findMany({ where: { id: row.id } })),
            { readOnly: true },
          ),
        ).rejects.toBeInstanceOf(MarketGuardError);
      });
    });

    describe('read-only units (ADR-0025)', () => {
      const readOnly = { readOnly: true } as const;

      it('sends no BEGIN, SET TRANSACTION, COMMIT or ROLLBACK: only its statements', async () => {
        await driver.during(() =>
          db.unitOfWork.run(
            market,
            async () => {
              const tx = auditTx(market);
              const where = { marketId: market.marketId, targetId: 'read-only' };
              await tx.auditLog.count({ where });
              await tx.auditLog.findMany({ where, take: 1 });
              return ok(undefined);
            },
            readOnly,
          ),
        );

        expect(driver.statements.map(statementKind)).toEqual(['SELECT', 'SELECT']);
      });

      it.each([
        ['a read-only unit', true],
        ['a read-write unit (control)', false],
      ])(
        'runs a blocked statement of %s in an implicit transaction only if read-only',
        async (_case, isReadOnly) => {
          const applicationName = `uow-${randomUUID().slice(0, 8)}`;
          const probe = onLockingDatabase({ urlParameters: { application_name: applicationName } });
          await owner.query('BEGIN');
          let unit: Promise<unknown> | undefined;
          try {
            await owner.query('LOCK TABLE platform.audit_log IN ACCESS EXCLUSIVE MODE');
            unit = probe.unitOfWork.run(
              market,
              async () =>
                ok(await auditTx(market).auditLog.count({ where: { marketId: market.marketId } })),
              isReadOnly ? readOnly : {},
            );
            let blocked: { same_start: boolean }[] = [];
            for (let poll = 0; poll < 100 && blocked.length === 0; poll += 1) {
              await sleep(20);
              ({ rows: blocked } = await observer.query<{ same_start: boolean }>(
                `SELECT xact_start = query_start AS same_start FROM pg_stat_activity
                  WHERE application_name = $1 AND wait_event_type = 'Lock'`,
                [applicationName],
              ));
            }

            expect(blocked).toEqual([{ same_start: isReadOnly }]);
          } finally {
            await owner.query('ROLLBACK');
          }
          await unit;
          const { rows } = await observer.query<{ state: string }>(
            'SELECT state FROM pg_stat_activity WHERE application_name = $1',
            [applicationName],
          );
          await probe.close();
          expect(rows.filter((row) => row.state === 'idle in transaction')).toEqual([]);
        },
      );

      it.each([
        ['create', (m: MarketContext) => ({ data: auditRow(m) })],
        ['createMany', (m: MarketContext) => ({ data: [auditRow(m)] })],
        ['createManyAndReturn', (m: MarketContext) => ({ data: [auditRow(m)] })],
        [
          'updateMany',
          (m: MarketContext) => ({ where: { marketId: m.marketId }, data: { action: 'a.b.c' } }),
        ],
        ['deleteMany', (m: MarketContext) => ({ where: { marketId: m.marketId } })],
      ])('refuses the write %s', async (operation, args) => {
        const data = args(market);
        const run = db.unitOfWork.run(
          market,
          async () => {
            const delegate = auditTx(market).auditLog as unknown as Record<
              string,
              (a: unknown) => Promise<unknown>
            >;
            await delegate[operation]!(data);
            return ok(undefined);
          },
          readOnly,
        );

        await expect(run).rejects.toMatchObject({
          name: 'MarketGuardError',
          reason: 'write-in-read-only-unit',
        });
        const rows = (data as { data?: unknown }).data;
        const ids = (Array.isArray(rows) ? rows : [rows])
          .map((row) => (row as { id?: string } | undefined)?.id)
          .filter((id): id is string => id !== undefined);
        for (const id of ids) await expect(rowExists(id)).resolves.toBe(false);
      });

      it("refuses a read for the other fixture's Market", async () => {
        const run = db.unitOfWork.run(
          market,
          async () =>
            ok(await auditTx(market).auditLog.findMany({ where: { marketId: other.marketId } })),
          readOnly,
        );

        await expect(run).rejects.toMatchObject({ reason: 'where-market-mismatch' });
      });

      it("refuses the other fixture's context in a read-only unit", async () => {
        const run = db.unitOfWork.run(
          market,
          inline(() => {
            db.service.tx(other);
            return ok(undefined);
          }),
          readOnly,
        );

        await expect(run).rejects.toThrow(MarketMismatchError);
      });

      it('refuses a query started inside and awaited after run returns (condition (a))', async () => {
        let late: Promise<unknown> | undefined;
        let deferred: Promise<unknown> | undefined;
        const released = gate();

        await db.unitOfWork.run(
          market,
          inline(() => {
            const tx = auditTx(market);
            late = tx.auditLog.count({ where: { marketId: market.marketId } });
            // A callback scheduled inside the unit keeps its store, which is closed by then.
            deferred = new Promise((resolve, reject) => {
              void released.opened.then(() =>
                tx.auditLog.count({ where: { marketId: market.marketId } }).then(resolve, reject),
              );
            });
            return ok(undefined);
          }),
          readOnly,
        );
        released.open();

        await expect(late).rejects.toMatchObject({ reason: 'no-open-unit' });
        await expect(deferred).rejects.toMatchObject({ reason: 'unit-closed' });
      });

      it.each([
        [{ readOnly: true, isolation: 'serializable' as const }, 'read-only-with-isolation'],
        [{ readOnly: true, timeoutMs: 1000 }, 'read-only-with-timeout'],
        [{ timeoutMs: 30_001 }, 'timeout-out-of-range'],
        [{ timeoutMs: 0 }, 'timeout-out-of-range'],
        [{ isolation: 'repeatable-read' as never }, 'unknown-isolation'],
      ])('refuses the options %j (condition (c))', async (options, reason) => {
        const run = db.unitOfWork.run(market, () => Promise.resolve(ok(undefined)), options);

        await expect(run).rejects.toEqual(new InvalidUnitOfWorkOptionsError(reason as never));
      });
    });
  });

  describe('HTTP: a conflict answers 409 conflict.retry (P 10)', () => {
    @Controller('test/unit-of-work')
    class ConflictProbeController {
      constructor(@Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork) {}

      @Get('conflict')
      async conflict(@Market() market: MarketContext): Promise<{ status: string }> {
        await this.unitOfWork.run(market, async () => {
          const row = auditRow(market, { action: CONFLICT_AT_COMMIT });
          await auditTx(market).auditLog.create({ data: row });
          return ok(undefined);
        });
        return { status: 'saved' };
      }
    }

    it.each(TEST_MARKETS)('answers 409 with the code only, for %s', async (code) => {
      const { app } = await createTestApp({
        env: { DATABASE_URL: lockingTestDatabaseUrl() },
        controllers: [ConflictProbeController],
      });
      try {
        const response = await request(app.getHttpServer() as App)
          .get('/test/unit-of-work/conflict')
          .set('x-market-id', code)
          .expect(409);

        expect(response.body).toEqual({ statusCode: 409, code: 'conflict.retry' });
      } finally {
        await app.close();
      }
    });
  });

  describe('role and database settings (data platform.md 10.4, ADR-0025 decision 2)', () => {
    it('as the login role outside a transaction: plan_cache_mode auto, read-write default', async () => {
      const { rows } = await observer.query(
        `SELECT current_setting('plan_cache_mode') AS plan_cache_mode,
                current_setting('default_transaction_read_only') AS read_only,
                current_setting('default_transaction_isolation') AS isolation`,
      );

      expect(rows).toEqual([
        { plan_cache_mode: 'auto', read_only: 'off', isolation: 'read committed' },
      ]);
    });

    it('sets default_transaction_isolation and _read_only on no login role, the group, every role or this database', async () => {
      // Only the entries that reach the application login here: this database or every
      // database (0), and the two logins, the group or every role (0). Other databases of the
      // cluster, such as the DatabaseProbe scratch database below, are not looked at.
      const { rows } = await observer.query(
        `SELECT s.setdatabase, s.setrole, s.setconfig FROM pg_db_role_setting s
          CROSS JOIN LATERAL unnest(s.setconfig) AS setting
          WHERE s.setdatabase IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
            AND s.setrole IN (0, (SELECT oid FROM pg_roles WHERE rolname = current_user),
                              (SELECT oid FROM pg_roles WHERE rolname = 'drive_app'),
                              (SELECT oid FROM pg_roles WHERE rolname = 'drive_migrator'))
            AND (setting LIKE 'default\\_transaction\\_isolation=%'
                 OR setting LIKE 'default\\_transaction\\_read\\_only=%')`,
      );

      expect(rows).toEqual([]);
    });

    it('the login role carries the three timeouts; the migration role and drive_app none (K1a, Hassan L5)', async () => {
      const configOf = async (role: string): Promise<string[]> =>
        (
          await observer.query<{ rolconfig: string[] | null }>(
            'SELECT rolconfig FROM pg_roles WHERE rolname = $1',
            [role],
          )
        ).rows[0]?.rolconfig ?? [];
      const login = await configOf(
        (await observer.query<{ name: string }>('SELECT current_user AS name')).rows[0]!.name,
      );
      const isTimeout = (entry: string) =>
        /^(statement_timeout|lock_timeout|idle_in_transaction_session_timeout)=/.test(entry);

      expect(login).toEqual(
        expect.arrayContaining([
          'statement_timeout=30s',
          'lock_timeout=3s',
          'idle_in_transaction_session_timeout=60s',
        ]),
      );
      expect(login.filter((entry) => entry.startsWith('plan_cache_mode='))).toEqual(
        login.some((entry) => entry.startsWith('plan_cache_mode=')) ? ['plan_cache_mode=auto'] : [],
      );
      expect((await configOf('drive_migrator')).filter(isTimeout)).toEqual([]);
      expect((await configOf('drive_app')).filter(isTimeout)).toEqual([]);

      const { rows } = await observer.query<{ default_transaction_read_only: string }>(
        'SHOW default_transaction_read_only',
      );
      expect(rows).toEqual([{ default_transaction_read_only: 'off' }]);
    });
  });

  describe('DatabaseProbe refuses to start on another default isolation (ADR-0025)', () => {
    it('passes on the test database, as the application role', async () => {
      const probe = new DatabaseProbe(db.root);

      await expect(probe.defaultTransactionIsolation()).resolves.toBe('read committed');
    });

    it('refuses a database whose default is serializable, with a logged reason', async () => {
      // A database of its own, so no other test's new connection sees the setting.
      const name = `isolation_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
      const admin = new Client({ connectionString: migrationDatabaseUrl() });
      await admin.connect();
      await admin.query(`CREATE DATABASE "${name}"`);
      await admin.query(`REVOKE ALL ON DATABASE "${name}" FROM PUBLIC`);
      await admin.query(`GRANT CONNECT ON DATABASE "${name}" TO "drive_app"`);
      await admin.query(
        `ALTER DATABASE "${name}" SET default_transaction_isolation = 'serializable'`,
      );
      const url = new URL(testDatabaseUrl());
      url.pathname = `/${name}`;
      const root = new PrismaRoot(testAppConfig({ DATABASE_URL: url.toString() }));
      const errors: unknown[] = [];
      try {
        const accepted = await databaseIsolationAccepted(new DatabaseProbe(root), {
          log: () => undefined,
          warn: () => undefined,
          error: (...args: unknown[]) => void errors.push(args),
        });

        expect(accepted).toBe(false);
        expect(errors).toEqual([
          [
            'The database was refused by the start-up self-check: default_transaction_isolation is "serializable", not "read committed" (ADR-0025)',
            'DatabaseIsolationCheck',
          ],
        ]);
      } finally {
        await root.$disconnect();
        await admin.query(`ALTER DATABASE "${name}" RESET default_transaction_isolation`);
        await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
        await admin.end();
      }
    });
  });
});
