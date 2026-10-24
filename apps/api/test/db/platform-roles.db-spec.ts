import { randomBytes, randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ok } from '@mondapac-drive/shared-kernel';
import type { Id } from '@mondapac-drive/shared-kernel';
import { testAuthenticatedActor, testCallContext } from '@mondapac-drive/shared-kernel/testing';
import { Client } from 'pg';
import { AssignAdminRole } from '../../src/modules/identity/application/use-cases/assign-admin-role.use-case';
import { InviteAdmin } from '../../src/modules/identity/application/use-cases/invite-admin.use-case';
import { ListPlatformRoles } from '../../src/modules/identity/application/use-cases/list-platform-roles.use-case';
import { SeedRoles } from '../../src/modules/identity/application/use-cases/seed-roles.use-case';
import { TransactionConflictError } from '../../src/platform/unit-of-work/errors';
import { PrismaRoleRepository } from '../../src/modules/identity/infrastructure/roles/prisma-role.repository';
import { realPermissionRegistry } from '../support/permission-registry';
import { createTestApp } from '../support/test-app';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  recordDriverStatements,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Identity slices 10a and 10 (the extended read) on PostgreSQL (identity design 5.3 `identity.platform-role.view`), for both
// Market fixtures, as the application role on the run database: the role catalogue through the
// real gate, use case and Prisma ports, in read-only units with no transaction (ADR-0025), and
// `RoleRepository.platformRoles` (this Market's platform roles with their stored keys, never a
// merchant's or courier's role). Other files may add platform roles to the same Markets meanwhile, so a case
// asserts on its own rows and on what every returned row is, never on the exact list.

const CREATED = '2026-10-09T00:00:00Z';
const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0c2FsdA$dGFn';
const newId = <T extends string>(): Id<T> =>
  `01990000-0000-7000-8000-${randomBytes(6).toString('hex')}` as Id<T>;

async function untilNoConflict<T>(run: () => Promise<T>, attempts = 5): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof TransactionConflictError) || attempt >= attempts) throw error;
    }
  }
}

describe.each(TEST_MARKETS)('the role catalogue in market %s (database, slice 10a)', (code) => {
  const market = marketOf(code);
  const other = otherMarketOf(code);
  let app: NestExpressApplication;
  let sql: Client;
  let db: Persistence;
  let driver: ReturnType<typeof recordDriverStatements>;
  let logs: jest.SpyInstance[];

  beforeAll(async () => {
    ({ app } = await createTestApp({ env: { DATABASE_URL: testDatabaseUrl() } }));
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
    db = createPersistence();
    driver = recordDriverStatements();
    for (const each of [market, marketOf(other)]) {
      await app
        .get(SeedRoles)
        .execute(testCallContext(each, 'system', `db-roles-${randomUUID()}`), {});
    }
  });
  afterAll(async () => {
    driver.restore();
    await db.close();
    await sql.end();
    await app.close();
  });
  beforeEach(() => {
    logs = (['log', 'warn', 'error', 'debug'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
  });
  afterEach(() => logs.forEach((spy) => spy.mockRestore()));

  async function seededRole(seedCode: string, scope = 'platform'): Promise<Id<'Role'>> {
    const { rows } = await sql.query<{ id: string }>(
      `SELECT id FROM identity.roles WHERE market_id = $1 AND scope = $2 AND seed_code = $3`,
      [code, scope, seedCode],
    );
    return rows[0]!.id as Id<'Role'>;
  }

  /** A platform custom role of `marketCode` with `keys` (its name is never read by 10a). */
  async function customRole(keys: string[], marketCode: string = code): Promise<Id<'Role'>> {
    const id = newId<'Role'>();
    const name = `Role ${id}`;
    await sql.query(
      `INSERT INTO identity.roles (id, market_id, tenant_id, scope, kind, seed_code, seed_version,
       name, name_normalized, version, created_at)
       VALUES ($1, $2, 'default', 'platform', 'custom', NULL, NULL, $3, $4, 1, $5)`,
      [id, marketCode, name, name.toLowerCase(), CREATED],
    );
    for (const key of keys) {
      await sql.query(
        `INSERT INTO identity.role_permissions (market_id, tenant_id, role_id, permission_key)
         VALUES ($1, 'default', $2, $3)`,
        [marketCode, id, key],
      );
    }
    return id;
  }

  async function admin(roleId: Id<'Role'>): Promise<Id<'Account'>> {
    const id = newId<'Account'>();
    const email = `Admin.${id}@Roles.example`;
    await sql.query(
      `INSERT INTO identity.accounts (id, market_id, tenant_id, population, email,
       email_normalized, display_name, status, email_verified_at, signed_up_at, version, created_at)
       VALUES ($1, $2, 'default', 'admin', $3, $4, 'Role Reader', 'active', $5, $5, 1, $5)`,
      [id, code, email, email.toLowerCase(), CREATED],
    );
    await sql.query(
      `INSERT INTO identity.password_credentials
         (market_id, tenant_id, account_id, password_hash, changed_at)
       VALUES ($1, 'default', $2, $3, $4)`,
      [code, id, PASSWORD_HASH, CREATED],
    );
    await sql.query(
      `INSERT INTO identity.role_assignments (id, market_id, tenant_id, account_id, role_id,
       assigned_by_account_id, assigned_at, version)
       VALUES ($1, $2, 'default', $3, $4, NULL, $5, 1)`,
      [newId(), code, id, roleId, CREATED],
    );
    return id;
  }

  const as = (accountId: Id<'Account'>) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId,
        sessionId: newId<'Session'>(),
        merchantId: null,
      }),
      `db-roles-${randomUUID()}`,
    );

  it('lists only this Market’s platform roles, with the counts and grantable of the policy', async () => {
    const narrow = await customRole([
      'identity.admin-account.view',
      'identity.platform-role.assign',
      'identity.platform-role.view',
    ]);
    const elsewhere = await customRole(['identity.platform-role.view'], other);
    const root = await admin(await seededRole('platform-administrator'));
    const reader = await admin(narrow);

    const result = await app.get(ListPlatformRoles).execute(as(reader), {});

    if (!result.ok) throw new Error(`listed: ${result.error.code}`);
    const items = result.value.items;
    const ids = items.map((item) => item.roleId as string);
    expect(ids).toEqual([...ids].sort());
    const { rows } = await sql.query<{ market_id: string; scope: string }>(
      'SELECT DISTINCT market_id, scope FROM identity.roles WHERE id = ANY($1::uuid[])',
      [ids],
    );
    expect(rows).toEqual([{ market_id: code, scope: 'platform' }]);
    expect(ids).not.toContain(elsewhere);
    expect(ids).not.toContain(await seededRole('merchant', 'merchant'));
    expect(ids).not.toContain(await seededRole('courier', 'courier'));
    const entry = (roleId: string) => items.find((item) => item.roleId === roleId)!;
    expect(entry(narrow)).toMatchObject({
      roleId: narrow,
      kind: 'custom',
      seedCode: null,
      name: `Role ${narrow}`,
      permissionCount: 3,
      permissionKeys: [
        'identity.admin-account.view',
        'identity.platform-role.assign',
        'identity.platform-role.view',
      ],
      // Protected keys (assign) without the system role: R11.
      grantable: false,
    });
    // The operator holds keys the reader lacks (R1).
    expect(entry(await seededRole('operator'))).toMatchObject({
      permissionCount: 7,
      grantable: false,
    });
    expect(entry(await seededRole('platform-administrator'))).toMatchObject({
      kind: 'system',
      grantable: false,
    });

    const asRoot = await app.get(ListPlatformRoles).execute(as(root), {});
    if (!asRoot.ok) throw new Error(`listed: ${asRoot.error.code}`);
    expect(asRoot.value.items.every((item) => item.grantable)).toBe(true);
  });

  it('runs the gate and the read in read-only units: SELECTs only, no transaction (ADR-0025)', async () => {
    const root = await admin(await seededRole('platform-administrator'));

    const result = await driver.during(() => app.get(ListPlatformRoles).execute(as(root), {}));

    expect(result.ok).toBe(true);
    expect(driver.statements.length).toBeGreaterThan(0);
    for (const statement of driver.statements) {
      expect(statement.trim()).not.toMatch(/^(BEGIN|COMMIT|ROLLBACK|SET TRANSACTION)/i);
      expect(statement.trim()).toMatch(/^SELECT/i);
    }
  });

  it('permissionCount and grantable are what the assign and invite commands answer (parity, Sajad on 10a)', async () => {
    const platformKeyCount = realPermissionRegistry().keysOf('platform').size;
    const lead = await customRole([
      'identity.admin-account.invite',
      'identity.admin-account.view',
      'identity.platform-role.assign',
      'identity.platform-role.view',
      'identity.merchant.view',
    ]);
    const narrow = await customRole([
      'identity.admin-account.invite',
      'identity.platform-role.assign',
      'identity.platform-role.view',
    ]);
    const low = await customRole(['identity.merchant.view']);
    const actors = [
      await admin(await seededRole('platform-administrator')),
      await admin(lead),
      await admin(narrow),
    ];
    const seen = new Set<string>();
    // Other files add and delete platform roles in these Markets meanwhile, and role-seed.db-spec
    // takes a key off seeded roles for a moment: this case checks the system role (its keys are
    // derived, not stored) and its own roles, which nobody else touches.
    const { rows: seededRows } = await sql.query<{ id: string }>(
      `SELECT id FROM identity.roles WHERE market_id = $1 AND scope = 'platform'
       AND seed_code = 'platform-administrator'`,
      [code],
    );
    const own = new Set<string>([lead, narrow, low, ...seededRows.map((r) => r.id)]);

    for (const actor of actors) {
      const listed = await app.get(ListPlatformRoles).execute(as(actor), {});
      if (!listed.ok) throw new Error(`listed: ${listed.error.code}`);
      for (const entry of listed.value.items.filter((item) => own.has(item.roleId))) {
        // permissionCount: what the role confers through the one resolver, from the stored rows.
        const { rows } = await sql.query<{ n: string }>(
          `SELECT count(*) AS n FROM identity.role_permissions
           WHERE market_id = $1 AND role_id = $2 AND permission_key = ANY($3::text[])`,
          [code, entry.roleId, [...realPermissionRegistry().keysOf('platform')]],
        );
        const stored = Number(rows[0]!.n);
        const declared = entry.kind === 'system' ? platformKeyCount : stored;
        expect(entry.permissionCount).toBe(declared);
        expect(entry.permissionKeys).toHaveLength(declared);
        // grantable: neither command refuses the role as not grantable or out of reach. A fresh
        // target and a fresh invitation address for each pair.
        // Other identity files write roles in this Market at the same time, so a serializable unit
        // may run out of its own retries; only that conflict is retried here, never an answer.
        const target = await admin(low);
        const assigned = await untilNoConflict(() =>
          app.get(AssignAdminRole).execute(as(actor), { accountId: target, roleId: entry.roleId }),
        );
        const invited = await untilNoConflict(() =>
          app.get(InviteAdmin).execute(as(actor), {
            origin: '203.0.113.9',
            email: `Parity.${randomUUID()}@Roles.example`,
            roleId: entry.roleId,
          }),
        );
        const refused = (result: { ok: boolean; error?: { code: string } }) =>
          !result.ok && ['role.not-grantable', 'role.unknown'].includes(result.error!.code);
        expect(entry.grantable).toBe(!refused(assigned) && !refused(invited));
        seen.add(`${actor === actors[0] ? 'system' : 'other'}:${entry.grantable}`);
      }
    }
    // Both answers occur: the system role may give every role, the others not all.
    expect([...seen].sort()).toEqual(['other:false', 'other:true', 'system:true']);
  });

  it('reads the platform roles with their stored keys as findById does, by the Market', async () => {
    const roles = new PrismaRoleRepository(db.service);
    const keys = ['identity.courier-account.view', 'identity.merchant.view'];
    const mine = await customRole(keys);

    const read = await db.unitOfWork.run(
      market,
      async () => {
        const all = await roles.platformRoles(market);
        const one = await roles.findById(market, mine);
        return ok({ all, one });
      },
      { readOnly: true },
    );

    if (!read.ok) throw new Error('read failed');
    const listed = read.value.all.find((role) => role.state.id === mine)!;
    expect(listed.state).toEqual(read.value.one!.state);
    expect(listed.state.permissionKeys).toEqual(keys);
    for (const role of read.value.all) {
      expect([role.state.marketId, role.state.scope]).toEqual([code, 'platform']);
    }
    const operator = read.value.all.find((role) => role.state.seedCode === 'operator')!;
    expect(operator.state.permissionKeys).toHaveLength(7);
  });
});
