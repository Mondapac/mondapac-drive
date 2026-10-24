import { randomUUID } from 'node:crypto';
import { devNull } from 'node:os';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import pino from 'pino';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { APP_OPTIONS, configureApp } from '../../src/configure-app';
import { ok } from '@mondapac-drive/shared-kernel';
import type { MarketContext } from '@mondapac-drive/shared-kernel';
import { testMarketContext } from '@mondapac-drive/shared-kernel/testing';
import { PLATFORM_TENANT_ID } from '../../src/platform/market-context/tenant';
import { auditTx } from '../../src/platform/persistence/audit/audit-transaction';
import { DatabaseProbe } from '../../src/platform/persistence/database-probe';
import { findRoleProblems } from '../../src/platform/persistence/database-role-check';
import { PrismaRoot } from '../../src/platform/persistence/prisma-root';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import { testAppConfig, TEST_MARKETS } from '../support/test-config';
import { EXPECTED_PRIVILEGES } from './expected-privileges';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

const RESTRICT_VIOLATION = '23001';
const FEATURE_NOT_SUPPORTED = '0A000';
const CHECK_VIOLATION = '23514';
const INSUFFICIENT_PRIVILEGE = '42501';
const APPLICATION_GROUP_ROLE = 'drive_app';

/** Runs one statement in a transaction that is always rolled back; answers its SQLSTATE. */
async function sqlStateOf(client: Client, statement: string): Promise<string> {
  await client.query('BEGIN');
  try {
    await client.query(statement);
    return 'ok';
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown';
  } finally {
    await client.query('ROLLBACK');
  }
}

function auditRow(marketId: string, overrides: Record<string, unknown> = {}) {
  return {
    // The application generates UUIDv7 ids; any UUID satisfies the column in a test.
    id: randomUUID(),
    marketId,
    tenantId: PLATFORM_TENANT_ID,
    occurredAt: new Date('2026-10-01T00:00:00.000Z'),
    actorType: 'SYSTEM',
    action: 'platform.skeleton.checked',
    targetType: 'platform.skeleton',
    targetId: 'baseline',
    correlationId: 'db-test-correlation-0001',
    ...overrides,
  };
}

describe('platform persistence (database integration)', () => {
  let app: INestApplication<App>;
  let unitOfWork: UnitOfWork;
  /** The base client: reads that check what a unit left behind (platform persistence 13). */
  let root: PrismaRoot;
  /** The application login (`drive_app`), as `AppModule` connects. */
  let sql: Client;
  /** The owner of the throwaway database: the migration role. */
  let owner: Client;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.register({
          config: testAppConfig({ DATABASE_URL: testDatabaseUrl() }),
          logDestination: pino.destination(devNull),
        }),
      ],
    }).compile();
    const nestApp = moduleRef.createNestApplication<NestExpressApplication>(APP_OPTIONS);
    configureApp(nestApp);
    await nestApp.init();
    app = nestApp;
    unitOfWork = app.get<UnitOfWork>(UNIT_OF_WORK);
    root = app.get(PrismaRoot);

    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
  });

  afterAll(async () => {
    await owner.end();
    await sql.end();
    await app.close();
  });

  it('GET /health/ready reports ready when the database answers', async () => {
    const response = await request(app.getHttpServer()).get('/health/ready').expect(200);

    expect(response.body).toEqual({ status: 'ok' });
  });

  /** Writes one audit row in a read-write unit of its Market, as a platform writer would. */
  async function insertAudit(market: MarketContext, row: ReturnType<typeof auditRow>) {
    return unitOfWork.run(market, async () => {
      await auditTx(market).auditLog.create({ data: row });
      return ok(undefined);
    });
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);

  describe('platform.audit_log', () => {
    it.each(TEST_MARKETS)('accepts an audit row for market %s', async (marketId) => {
      const market = marketOf(marketId);
      const row = auditRow(marketId, { after: { status: 'checked' } });

      await insertAudit(market, row);

      const read = await unitOfWork.run(
        market,
        async () =>
          ok(await auditTx(market).auditLog.findUnique({ where: { id: row.id, marketId } })),
        { readOnly: true },
      );
      expect(read.ok && read.value).toMatchObject({
        marketId,
        actorType: 'SYSTEM',
        actorId: null,
        after: { status: 'checked' },
      });
    });

    it('is append-only even for its owner: UPDATE, DELETE and TRUNCATE are rejected', async () => {
      const row = auditRow('AU');
      await insertAudit(marketOf('AU'), row);

      // The application role is refused earlier, by privileges (42501); the owner reaches
      // the trigger (docs/design/data/platform.md 10.4).
      await expect(
        owner.query('UPDATE platform.audit_log SET action = $1 WHERE id = $2', ['x.y.z', row.id]),
      ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
      await expect(
        owner.query('DELETE FROM platform.audit_log WHERE id = $1', [row.id]),
      ).rejects.toMatchObject({ code: RESTRICT_VIOLATION });
      // Since the seal's foreign key (docs/design/data/platform.md 11.3), a plain TRUNCATE is
      // refused before the trigger runs (0A000: the table is referenced); with CASCADE it
      // reaches the triggers of audit_log and of the seal, which refuse it.
      await expect(owner.query('TRUNCATE platform.audit_log')).rejects.toMatchObject({
        code: FEATURE_NOT_SUPPORTED,
      });
      await expect(owner.query('TRUNCATE platform.audit_log CASCADE')).rejects.toMatchObject({
        code: RESTRICT_VIOLATION,
        message: expect.stringContaining('platform.audit_log is append-only') as unknown,
      });

      await expect(root.auditLog.count({ where: { id: row.id } })).resolves.toBe(1);
    });

    it.each([
      ['a USER actor without actor_id', { actorType: 'USER' }, 'audit_log_actor_check'],
      ['a SYSTEM actor with actor_id', { actorId: randomUUID() }, 'audit_log_actor_check'],
      ['an unknown actor type', { actorType: 'ROBOT' }, 'audit_log_actor_type_check'],
      ['an empty market', { marketId: '' }, 'audit_log_market_id_check'],
      ['an empty tenant', { tenantId: '' }, 'audit_log_tenant_id_check'],
      ['an action that is not a dotted code', { action: 'Not A Code' }, 'audit_log_action_check'],
      ['an empty target id', { targetId: '' }, 'audit_log_target_id_check'],
      [
        'a target type that is not a dotted code',
        { targetType: 'Bad Type' },
        'audit_log_target_type_check',
      ],
      ['a non-object "after"', { after: 'text' }, 'audit_log_after_check'],
      [
        'impersonation without a real actor',
        { actingAsId: randomUUID() },
        'audit_log_acting_as_check',
      ],
      ['a non-object "before"', { before: ['not', 'an', 'object'] }, 'audit_log_before_check'],
      [
        'a malformed correlation id',
        { correlationId: 'has spaces in it' },
        'audit_log_correlation_id_check',
      ],
    ])('rejects %s', async (_case, overrides, constraint) => {
      const row = auditRow('ZZ', overrides);
      // The market and tenant cases name an empty value: the guard refuses those first, so
      // they are written with the unit's own values and checked on the base client.
      const viaGuard = row.marketId === 'ZZ' && row.tenantId === PLATFORM_TENANT_ID;
      const attempt = viaGuard
        ? insertAudit(marketOf('ZZ'), row)
        : root.auditLog.create({ data: row });

      await expect(attempt).rejects.toThrow(CHECK_VIOLATION);
      await expect(attempt).rejects.toThrow(`"${constraint}"`);
      await expect(root.auditLog.count({ where: { id: row.id } })).resolves.toBe(0);
    });
  });
  describe('the application role on platform.audit_log', () => {
    let tableOwner: string;
    let triggerName: string;
    let triggerFunction: string;

    beforeAll(async () => {
      const ownerRow = await sql.query<{ tableowner: string }>(
        "SELECT tableowner FROM pg_tables WHERE schemaname = 'platform' AND tablename = 'audit_log'",
      );
      tableOwner = ownerRow.rows[0]!.tableowner;
      const trigger = await sql.query<{ tgname: string; tgfoid: string }>(
        "SELECT tgname, tgfoid::regproc::text AS tgfoid FROM pg_trigger WHERE tgrelid = 'platform.audit_log'::regclass AND NOT tgisinternal ORDER BY tgname LIMIT 1",
      );
      triggerName = trigger.rows[0]!.tgname;
      triggerFunction = trigger.rows[0]!.tgfoid;
    });

    it('may INSERT and SELECT', async () => {
      const row = auditRow('ZZ');

      await sql.query(
        `INSERT INTO platform.audit_log
           (id, market_id, tenant_id, occurred_at, actor_type, action, target_type, target_id, correlation_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          row.id,
          row.marketId,
          row.tenantId,
          row.occurredAt,
          row.actorType,
          row.action,
          row.targetType,
          row.targetId,
          row.correlationId,
        ],
      );

      const selected = await sql.query('SELECT id FROM platform.audit_log WHERE id = $1', [row.id]);
      expect(selected.rows).toEqual([{ id: row.id }]);
    });

    it('is refused everything else, with 42501, and no row changes', async () => {
      // Other db-spec files write audit rows in parallel, so the rows that existed before are
      // compared, not the table's row count.
      const fingerprint = async (): Promise<Record<string, string>> =>
        Object.fromEntries(
          (
            await sql.query<{ id: string; row: string }>(
              'SELECT id::text AS id, md5(t::text) AS row FROM platform.audit_log t',
            )
          ).rows.map(({ id, row }) => [id, row]),
        );
      const before = await fingerprint();
      const statements = [
        "UPDATE platform.audit_log SET action = 'x.y.z'",
        'DELETE FROM platform.audit_log',
        'TRUNCATE platform.audit_log',
        'TRUNCATE platform.audit_log CASCADE',
        `ALTER TABLE platform.audit_log DISABLE TRIGGER "${triggerName}"`,
        'ALTER TABLE platform.audit_log DISABLE TRIGGER ALL',
        `DROP TRIGGER "${triggerName}" ON platform.audit_log`,
        `CREATE TRIGGER t_probe BEFORE INSERT ON platform.audit_log FOR EACH ROW EXECUTE FUNCTION ${triggerFunction}()`,
        'SET session_replication_role = replica',
        'SET LOCAL session_replication_role = replica',
        "SELECT set_config('session_replication_role', 'replica', false)",
        `SET ROLE "${tableOwner}"`,
        `SET SESSION AUTHORIZATION "${tableOwner}"`,
        'CREATE TABLE platform.t_probe (id integer)',
        'CREATE TABLE public.t_probe (id integer)',
        'CREATE TEMPORARY TABLE t_probe (id integer)',
        'CREATE SCHEMA s_probe',
        'DROP TABLE platform.audit_log',
        'LOCK TABLE platform.audit_log IN ACCESS EXCLUSIVE MODE',
        'SELECT id FROM platform.audit_log FOR UPDATE',
        'SELECT * FROM public._prisma_migrations',
      ];

      const states: Record<string, string> = {};
      for (const statement of statements) states[statement] = await sqlStateOf(sql, statement);

      expect(states).toEqual(
        Object.fromEntries(statements.map((statement) => [statement, INSUFFICIENT_PRIVILEGE])),
      );
      expect(Object.keys(before).length).toBeGreaterThan(0);
      expect(await fingerprint()).toEqual(expect.objectContaining(before));
    });

    it('gains nothing by granting itself UPDATE', async () => {
      // Not an error: PostgreSQL answers with warning 01007 and grants nothing.
      await sql.query('GRANT UPDATE ON platform.audit_log TO CURRENT_USER');

      const granted = await sql.query<{ granted: boolean }>(
        "SELECT has_table_privilege('platform.audit_log', 'UPDATE') AS granted",
      );
      expect(granted.rows[0]!.granted).toBe(false);
    });
  });

  describe('the application role on tables with a column-level UPDATE (10.4)', () => {
    // Driven by the privilege map, so a new such table needs no new test. The first one is
    // `platform.subject_keys` (identity slice 1); until then the list is empty.
    const tables = Object.entries(EXPECTED_PRIVILEGES.tables).filter(
      ([, entry]) => entry.columnUpdate.length > 0,
    );

    it('takes its tables from the privilege map', () => {
      expect(tables.map(([name]) => name)).toEqual(
        Object.keys(EXPECTED_PRIVILEGES.tables).filter(
          (name) => EXPECTED_PRIVILEGES.tables[name]!.columnUpdate.length > 0,
        ),
      );
    });

    it('may update the listed columns only', async () => {
      // A generated column (delivery's geography points) refuses every UPDATE with 428C9 before
      // any privilege is checked, so it is left out.
      for (const [name, entry] of tables) {
        const [schema, table] = name.split('.') as [string, string];
        const columns = await sql.query<{ attname: string }>(
          `SELECT a.attname FROM pg_attribute a
            WHERE a.attrelid = format('%I.%I', $1::text, $2::text)::regclass
              AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = '' ORDER BY a.attnum`,
          [schema, table],
        );
        const states: Record<string, string> = {};
        const expected: Record<string, string> = {};
        for (const { attname } of columns.rows) {
          states[attname] = await sqlStateOf(
            sql,
            `UPDATE "${schema}"."${table}" SET "${attname}" = "${attname}" WHERE false`,
          );
          expected[attname] = entry.columnUpdate.includes(attname) ? 'ok' : INSUFFICIENT_PRIVILEGE;
        }
        expect({ [name]: states }).toEqual({ [name]: expected });
      }
    });
  });

  describe('the connected application role', () => {
    it('has no role attribute beyond LOGIN', async () => {
      const { rows } = await sql.query(
        `SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
           FROM pg_roles WHERE rolname = current_user`,
      );

      expect(rows).toEqual([
        {
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolreplication: false,
          rolbypassrls: false,
        },
      ]);
    });

    it('is a member of itself and the application group only, and the group of nothing', async () => {
      const member = await sql.query<{ rolname: string; is_self: boolean }>(
        `SELECT rolname, rolname = current_user AS is_self FROM pg_roles
          WHERE pg_has_role(current_user, oid, 'MEMBER') ORDER BY rolname <> current_user, rolname`,
      );
      const groupMemberships = await sql.query(
        `SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member
          WHERE r.rolname = $1`,
        [APPLICATION_GROUP_ROLE],
      );

      expect(member.rows).toEqual([
        { rolname: expect.any(String) as string, is_self: true },
        { rolname: APPLICATION_GROUP_ROLE, is_self: false },
      ]);
      expect(groupMemberships.rows).toEqual([]);
    });

    it('is not, and is no member of, the owner of the database or of the audit log', async () => {
      const { rows } = await sql.query(
        `SELECT pg_has_role(current_user, d.datdba, 'MEMBER') AS database_owner,
                pg_has_role(current_user, c.relowner, 'MEMBER') AS audit_log_owner
           FROM pg_database d, pg_class c
          WHERE d.datname = current_database() AND c.oid = 'platform.audit_log'::regclass`,
      );

      expect(rows).toEqual([{ database_owner: false, audit_log_owner: false }]);
    });

    it('may create nothing, on the database or on any schema, and PUBLIC holds nothing on the database', async () => {
      const database = await sql.query(
        `SELECT has_database_privilege(current_database(), 'CREATE') AS create,
                has_database_privilege(current_database(), 'TEMPORARY') AS temporary,
                (SELECT count(*)::int FROM pg_database d CROSS JOIN LATERAL aclexplode(d.datacl) a
                  WHERE d.datname = current_database() AND a.grantee = 0) AS public_privileges`,
      );
      const schemas = await sql.query(
        "SELECT nspname FROM pg_namespace WHERE has_schema_privilege(oid, 'CREATE')",
      );

      expect(database.rows).toEqual([{ create: false, temporary: false, public_privileges: 0 }]);
      expect(schemas.rows).toEqual([]);
    });
  });

  describe('the start-up self-check (docs/design/data/platform.md 10.8)', () => {
    const run = (client: Client) =>
      findRoleProblems(async (text) => (await client.query<Record<string, unknown>>(text)).rows);

    it('passes on the application connection', async () => {
      await expect(run(sql)).resolves.toEqual([]);
    });

    it('refuses the owner connection under every reason code', async () => {
      const codes = new Set((await run(owner)).map((problem) => problem.code));

      expect([...codes].sort()).toEqual([
        'audit_log_privilege',
        'create_on_database',
        'create_on_schema',
        'owner_membership',
        'role_attribute',
        'role_membership',
        'role_timeouts',
        'temporary_on_database',
      ]);
    });

    it('names each of the three audit tables the owner may change (11.6)', async () => {
      const problems = await run(owner);

      expect(problems.filter((problem) => problem.code === 'audit_log_privilege')).toEqual([
        { code: 'audit_log_privilege', subject: 'platform.audit_chain_checkpoint' },
        { code: 'audit_log_privilege', subject: 'platform.audit_log' },
        { code: 'audit_log_privilege', subject: 'platform.audit_log_seal' },
      ]);
    });

    it('refuses the migration role for each missing timeout (it is never limited, 10.7)', async () => {
      const problems = await run(owner);

      expect(problems.filter((problem) => problem.code === 'role_timeouts')).toEqual([
        { code: 'role_timeouts', subject: 'statement_timeout' },
        { code: 'role_timeouts', subject: 'lock_timeout' },
        { code: 'role_timeouts', subject: 'idle_in_transaction_session_timeout' },
        { code: 'role_timeouts', subject: 'session.statement_timeout' },
        { code: 'role_timeouts', subject: 'session.lock_timeout' },
        { code: 'role_timeouts', subject: 'session.idle_in_transaction_session_timeout' },
      ]);
    });

    it('refuses an API pool whose connection options switch a timeout off (Hassan)', async () => {
      const url = new URL(testDatabaseUrl());
      url.searchParams.set('options', '-c statement_timeout=0');
      const root = new PrismaRoot(testAppConfig({ DATABASE_URL: url.toString() }));
      try {
        await expect(new DatabaseProbe(root).roleProblems()).resolves.toEqual([
          { code: 'role_timeouts', subject: 'session.statement_timeout' },
        ]);
      } finally {
        await root.$disconnect();
      }
    });

    it('passes the API pool built from the plain application URL', async () => {
      const root = new PrismaRoot(testAppConfig({ DATABASE_URL: testDatabaseUrl() }));
      try {
        await expect(new DatabaseProbe(root).roleProblems()).resolves.toEqual([]);
      } finally {
        await root.$disconnect();
      }
    });

    it('refuses a session whose login switched to another role (Hassan, item 7)', async () => {
      // The migration role is a member of pg_signal_backend in development and CI (10.1); the
      // same holds for a privileged login that connects with `options=-c role=drive_api`.
      await owner.query('BEGIN');
      try {
        // Rolled back below. Without USAGE on `platform` the check errors, which also fails
        // start-up; the grant lets it reach its rows.
        await owner.query('GRANT USAGE ON SCHEMA platform TO pg_signal_backend');
        await owner.query('SET LOCAL ROLE pg_signal_backend');
        const problems = await run(owner);

        expect(problems).toContainEqual({ code: 'session_role', subject: 'drive_migrator' });
        expect(problems).toContainEqual({
          code: 'role_attribute',
          subject: 'drive_migrator.rolcreatedb',
        });
      } finally {
        await owner.query('ROLLBACK');
      }
    });
  });
});
