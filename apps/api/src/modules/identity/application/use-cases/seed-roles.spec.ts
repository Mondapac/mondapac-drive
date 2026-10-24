import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac-drive/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testCallContext,
  testMarketContext,
} from '@mondapac-drive/shared-kernel/testing';
import { IdentityFakes } from '../../../../../test/support/identity-fakes';
import { realPermissionRegistry } from '../../../../../test/support/permission-registry';
import { keysCosting } from '../../../../../test/support/seed-key-fixtures';
import {
  TEST_MARKETS,
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
} from '../../../../../test/support/test-config';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../../../../platform/market-context/tenant';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import { MAX_SEED_KEYS_PER_ROW, RoleSeedApplied } from '../../domain/audit';
import { CheckedInRoleSeed } from '../../infrastructure/seed/checked-in-role-seed';
import type { RoleSeed, SeededRole } from '../ports/role-seed';
import type { RoleRepository } from '../ports/role.repository';
import { SEED_KEYS_BUDGET_BYTES } from '../roles/role-seed-budget';
import { SeedRoles } from './seed-roles.use-case';

// The seed routine of identity design 5.6 for slice 8a-1, in memory, for both Market fixtures:
// the default roles with their keys, the audited seed-version upgrade of system and default
// roles (Ali 2026-10-08; platform-audit.md 5 and 14), the boot-time key check repeated on every
// run, and convergence. The SQL and the real audit writer are in test/db/role-seed.db-spec.ts.

const START = Temporal.Instant.from('2026-10-08T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const gate = createUseCaseGate(markets, null);

/** The checked-in seed with some roles replaced, as a later build would ship it. */
const seedWith = (change: (role: SeededRole) => SeededRole): RoleSeed => ({
  roles: () => new CheckedInRoleSeed().roles().map(change),
});

describe.each(TEST_MARKETS)('SeedRoles in market %s (identity design 5.6; slice 8a-1)', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', PLATFORM_TENANT_ID);
  const system = testCallContext(market, 'system', 'seed-roles-0001');
  let fakes: IdentityFakes;
  // One id sequence per test, so runs for two Markets never mint the same role id.
  let ids: SequenceIdGenerator;
  let logs: jest.SpyInstance[];

  beforeEach(() => {
    fakes = new IdentityFakes();
    ids = new SequenceIdGenerator(new FixedClock(START));
    logs = (['log', 'warn', 'error'] as const).map((level) =>
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
    );
  });
  afterEach(() => logs.forEach((spy) => spy.mockRestore()));

  const logged = (msg: string): unknown[] | undefined =>
    logs
      .flatMap((spy) => spy.mock.calls as unknown[][])
      .find((call) => (call[0] as { msg?: string }).msg === msg);

  const seedRoles = (
    seed: RoleSeed = new CheckedInRoleSeed(),
    overrides: { roles?: RoleRepository; audit?: AuditWriter } = {},
  ) => {
    const clock = new FixedClock(START);
    return new SeedRoles(gate, {
      unitOfWork: fakes.unitOfWork,
      roles: overrides.roles ?? fakes.roleRepository,
      seed,
      permissions: realPermissionRegistry(),
      clock,
      ids,
      audit: overrides.audit ?? fakes.audit,
    });
  };
  const roleOf = (scope: string, seedCode: string) =>
    [...fakes.roles.values()].find(
      (r) => r.marketId === market.marketId && r.scope === scope && r.seedCode === seedCode,
    )!;

  it('creates the default roles of 5.6 with their keys, as shared rows (R9), once', async () => {
    await expect(seedRoles().execute(system, {})).resolves.toEqual({
      ok: true,
      value: { created: 5, upgraded: 0 },
    });

    expect(roleOf('platform', 'dispatcher')).toMatchObject({
      kind: 'default',
      seedVersion: 2,
      permissionKeys: [
        'delivery.delivery.cancel',
        'delivery.delivery.dispatch',
        'delivery.delivery.view',
        'identity.courier-account.disable',
        'identity.courier-account.invite',
        'identity.courier-account.view',
        'tracking.map.view',
      ],
    });
    expect(roleOf('merchant', 'merchant')).toMatchObject({ kind: 'system', permissionKeys: [] });
    expect(roleOf('courier', 'courier')).toMatchObject({ kind: 'system', permissionKeys: [] });
    // One identity.role.seeded per created role, as the system, with its kind and version.
    expect(fakes.audits).toHaveLength(5);
    expect(new Set(fakes.audits.map((a) => `${a.action}|${a.actor}|${a.marketId}`))).toEqual(
      new Set([`identity.role.seeded|system|${code}`]),
    );
    expect(
      fakes.audits.filter((a) => (a.after as { kind: string }).kind === 'default'),
    ).toHaveLength(2);

    // A second run, and a run in the other Market, never touch these rows.
    await expect(seedRoles().execute(system, {})).resolves.toEqual({
      ok: true,
      value: { created: 0, upgraded: 0 },
    });
    expect(fakes.audits).toHaveLength(5);
    await seedRoles().execute(testCallContext(other, 'system', 'seed-roles-0002'), {});
    expect([...fakes.roles.values()].filter((r) => r.marketId === market.marketId)).toHaveLength(5);
  });

  it('upgrades a default role key by key, with one seed-applied row (Ali 2026-10-08)', async () => {
    await seedRoles().execute(system, {});
    const before = roleOf('platform', 'dispatcher');
    fakes.audits.length = 0;
    const v2 = seedWith((role) =>
      role.seedCode === 'dispatcher'
        ? {
            ...role,
            seedVersion: 3,
            permissionKeys: ['delivery.delivery.view', 'identity.merchant.view'],
          }
        : role,
    );

    await expect(seedRoles(v2).execute(system, {})).resolves.toEqual({
      ok: true,
      value: { created: 0, upgraded: 1 },
    });

    expect(roleOf('platform', 'dispatcher')).toMatchObject({
      id: before.id,
      seedVersion: 3,
      version: before.version + 1,
      permissionKeys: ['delivery.delivery.view', 'identity.merchant.view'],
    });
    expect(fakes.audits).toEqual([
      {
        ...RoleSeedApplied.entry(before.id, {
          before: { seedVersion: 2 },
          after: {
            seedVersion: 3,
            addedKeys: ['identity.merchant.view'],
            removedKeys: [
              'delivery.delivery.cancel',
              'delivery.delivery.dispatch',
              'identity.courier-account.disable',
              'identity.courier-account.invite',
              'identity.courier-account.view',
              'tracking.map.view',
            ],
          },
        }),
        actor: 'system',
        marketId: code,
      },
    ]);
    expect(logged('identity.seed-roles.upgraded')?.[0]).toMatchObject({
      roleId: before.id,
      fromSeedVersion: 2,
      seedVersion: 3,
    });

    // Applied once: the next run finds the role current and writes nothing.
    await expect(seedRoles(v2).execute(system, {})).resolves.toEqual({
      ok: true,
      value: { created: 0, upgraded: 0 },
    });
    expect(fakes.audits).toHaveLength(1);
  });

  it('upgrades a system role: the version only, an audited update, never ON CONFLICT DO NOTHING', async () => {
    await seedRoles().execute(system, {});
    const before = roleOf('platform', 'platform-administrator');
    fakes.audits.length = 0;
    const v2 = seedWith((role) =>
      role.seedCode === 'platform-administrator' ? { ...role, seedVersion: 2 } : role,
    );

    await expect(seedRoles(v2).execute(system, {})).resolves.toMatchObject({
      value: { upgraded: 1 },
    });

    expect(roleOf('platform', 'platform-administrator')).toMatchObject({
      kind: 'system',
      seedVersion: 2,
      permissionKeys: [],
    });
    expect(fakes.audits.map((a) => [a.action, a.targetId, a.before, a.after])).toEqual([
      [
        'identity.role.seed-applied',
        before.id,
        { seedVersion: 1 },
        { seedVersion: 2, addedKeys: [], removedKeys: [] },
      ],
    ]);
  });

  it('never downgrades a role stored at a newer version (an older build running), and warns', async () => {
    await seedRoles(
      seedWith((role) => (role.seedCode === 'operator' ? { ...role, seedVersion: 15 } : role)),
    ).execute(system, {});
    fakes.audits.length = 0;

    await expect(seedRoles().execute(system, {})).resolves.toEqual({
      ok: true,
      value: { created: 0, upgraded: 0 },
    });

    expect(roleOf('platform', 'operator').seedVersion).toBe(15);
    expect(fakes.audits).toEqual([]);
    expect(logged('identity.seed-roles.stored-newer')?.[0]).toMatchObject({
      seedCode: 'operator',
      storedSeedVersion: 15,
      seedVersion: 2,
    });
  });

  it('never changes a stored role of another kind under the same code', async () => {
    await seedRoles().execute(system, {});
    const stored = roleOf('platform', 'operator');
    fakes.roles.set(stored.id, { ...stored, kind: 'system', permissionKeys: [] });
    fakes.audits.length = 0;

    await seedRoles(
      seedWith((role) => (role.seedCode === 'operator' ? { ...role, seedVersion: 3 } : role)),
    ).execute(system, {});

    expect(fakes.roles.get(stored.id)!.seedVersion).toBe(2);
    expect(fakes.audits).toEqual([]);
    expect(logged('identity.seed-roles.kind-mismatch')).toBeDefined();
  });

  it.each<[string, (role: SeededRole) => SeededRole, string]>([
    [
      'an unknown key',
      (r) => (r.seedCode === 'operator' ? { ...r, permissionKeys: ['identity.ledger.view'] } : r),
      'unknown-key',
    ],
    [
      'a key of another scope',
      (r) => (r.seedCode === 'operator' ? { ...r, permissionKeys: ['delivery.booking.view'] } : r),
      'wrong-scope',
    ],
    [
      'a protected key (R11)',
      (r) =>
        r.seedCode === 'dispatcher' ? { ...r, permissionKeys: ['identity.merchant.create'] } : r,
      'protected-key',
    ],
    [
      'a key on a system role (R3)',
      (r) =>
        r.seedCode === 'courier' ? { ...r, permissionKeys: ['delivery.assignment.view'] } : r,
      'system-keys',
    ],
    [
      'more keys than one seed-applied row can list',
      (r) =>
        r.seedCode === 'operator'
          ? {
              ...r,
              permissionKeys: Array.from(
                { length: MAX_SEED_KEYS_PER_ROW + 1 },
                (_, n) => `identity.fixture-${n}.view`,
              ),
            }
          : r,
      'too-many-keys',
    ],
    [
      'keys one byte over the budget of one seed-applied list',
      (r) =>
        r.seedCode === 'operator'
          ? { ...r, permissionKeys: keysCosting(SEED_KEYS_BUDGET_BYTES + 1, 'over') }
          : r,
      'keys-too-large',
    ],
  ])('refuses the whole seed with %s, writing nothing', async (_case, change, problem) => {
    await expect(seedRoles(seedWith(change)).execute(system, {})).resolves.toEqual({
      ok: false,
      error: { code: 'seed.invalid' },
    });
    expect(fakes.roles.size).toBe(0);
    expect(fakes.audits).toEqual([]);
    expect(logged('identity.seed-roles.invalid')?.[0]).toMatchObject({ problem });
  });

  it('converges when a concurrent run upgraded the role first', async () => {
    await seedRoles().execute(system, {});
    fakes.audits.length = 0;
    const racing: RoleRepository = {
      ...fakes.roleRepository,
      applySeed: (_m, upgrade) =>
        Promise.reject(new StaleAggregateError('role', upgrade.role.state.id)),
    };

    await expect(
      seedRoles(
        seedWith((role) => (role.seedCode === 'operator' ? { ...role, seedVersion: 4 } : role)),
        { roles: racing },
      ).execute(system, {}),
    ).resolves.toEqual({ ok: true, value: { created: 0, upgraded: 0 } });
    expect(fakes.audits).toEqual([]);
    expect(logged('identity.seed-roles.concurrent')).toBeDefined();
  });

  it('a refused audit row fails that role only: the run goes on and ends as seed.incomplete (PA W5; Mohammad 3)', async () => {
    await seedRoles().execute(system, {});
    fakes.audits.length = 0;
    const operator = roleOf('platform', 'operator');
    const refusing: AuditWriter = {
      record: (context, entry) =>
        entry.targetId === operator.id
          ? Promise.reject(new Error('audit refused'))
          : fakes.audit.record(context, entry),
    };

    await expect(
      seedRoles(
        seedWith((role) =>
          role.seedCode === 'operator' || role.seedCode === 'dispatcher'
            ? { ...role, seedVersion: 4 }
            : role,
        ),
        { audit: refusing },
      ).execute(system, {}),
    ).resolves.toEqual({ ok: false, error: { code: 'seed.incomplete', failed: 1 } });
    // The other upgrade still applied, with its row; the failure is logged by code, no message.
    expect(roleOf('platform', 'dispatcher').seedVersion).toBe(4);
    expect(fakes.audits.map((a) => [a.action, a.targetId])).toEqual([
      ['identity.role.seed-applied', roleOf('platform', 'dispatcher').id],
    ]);
    expect(logged('identity.seed-roles.role-failed')?.[0]).toEqual({
      msg: 'identity.seed-roles.role-failed',
      errorName: 'Error',
      scope: 'platform',
      seedCode: 'operator',
      marketId: market.marketId,
      correlationId: system.correlationId,
    });
    expect(logged('identity.seed-roles.incomplete')?.[0]).toMatchObject({
      created: 0,
      upgraded: 1,
      failed: 1,
    });
  });

  it('one role that fails never keeps the courier role from a new Market (Mohammad 3)', async () => {
    const failing: RoleRepository = {
      ...fakes.roleRepository,
      addSeeded: (m, role) =>
        role.state.seedCode === 'platform-administrator'
          ? Promise.reject(new Error('boom'))
          : fakes.roleRepository.addSeeded(m, role),
    };

    await expect(seedRoles(undefined, { roles: failing }).execute(system, {})).resolves.toEqual({
      ok: false,
      error: { code: 'seed.incomplete', failed: 1 },
    });
    expect(roleOf('courier', 'courier')).toMatchObject({ kind: 'system', seedVersion: 1 });
    expect([...fakes.roles.values()].filter((r) => r.marketId === market.marketId)).toHaveLength(
      new CheckedInRoleSeed().roles().length - 1,
    );
  });

  it('caps the keys of one row so that the row fits the writer (PA W4)', () => {
    expect(MAX_SEED_KEYS_PER_ROW).toBe(40);
    expect(RoleSeedApplied.after).toMatchObject({
      addedKeys: { kind: 'listOf', max: 40 },
      removedKeys: { kind: 'listOf', max: 40 },
    });
  });

  it('refuses any actor but the system', async () => {
    await expect(
      seedRoles().execute(testCallContext(market, 'anonymous'), {}),
    ).resolves.toMatchObject({ ok: false });
    expect(fakes.roles.size).toBe(0);
  });
});
