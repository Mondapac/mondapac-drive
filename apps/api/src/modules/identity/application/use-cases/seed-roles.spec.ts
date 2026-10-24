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
      value: { created: 13, upgraded: 0 },
    });

    expect(roleOf('platform', 'onboarding-compliance')).toMatchObject({
      kind: 'default',
      sellerId: null,
      seedVersion: 7,
      permissionKeys: [
        'certification.issuer.view',
        'certification.seller-certificate.review',
        'certification.seller-certificate.view',
        'certification.type.view',
        'identity.seller-access.approve',
        'identity.seller-access.suspend',
        'identity.seller-access.view',
        'identity.seller-account.create',
        'sellers.business-details.view',
        'sellers.seller-file.review',
        'sellers.seller.view',
      ],
    });
    expect(roleOf('seller', 'store-manager').permissionKeys).toEqual([
      'catalog.own-product.edit',
      'catalog.own-product.view',
      'certification.own-certificate.manage',
      'certification.own-certificate.view',
      'identity.seller-role.view',
      'identity.team-member.view',
    ]);
    expect(roleOf('seller', 'bookkeeper').permissionKeys).toEqual([]);
    // One identity.role.seeded per created role, as the system, with its kind and version.
    expect(fakes.audits).toHaveLength(13);
    expect(new Set(fakes.audits.map((a) => `${a.action}|${a.actor}|${a.marketId}`))).toEqual(
      new Set([`identity.role.seeded|system|${code}`]),
    );
    expect(
      fakes.audits.filter((a) => (a.after as { kind: string }).kind === 'default'),
    ).toHaveLength(11);

    // A second run, and a run in the other Market, never touch these rows.
    await expect(seedRoles().execute(system, {})).resolves.toEqual({
      ok: true,
      value: { created: 0, upgraded: 0 },
    });
    expect(fakes.audits).toHaveLength(13);
    await seedRoles().execute(testCallContext(other, 'system', 'seed-roles-0002'), {});
    expect([...fakes.roles.values()].filter((r) => r.marketId === market.marketId)).toHaveLength(
      13,
    );
  });

  it('upgrades onboarding-compliance from version 1 to 7: adds the sellers and certification keys, one seed-applied row, other roles untouched', async () => {
    const REVIEW = 'sellers.seller-file.review';
    const VIEW = 'sellers.seller.view';
    const DETAILS = 'sellers.business-details.view';
    const CERT_VIEW = 'certification.seller-certificate.view';
    const CERT_REVIEW = 'certification.seller-certificate.review';
    const ISSUER_VIEW = 'certification.issuer.view';
    const TYPE_VIEW = 'certification.type.view';
    // The previous build's definition: version 1 without the sellers and certification keys.
    const v1 = seedWith((role) =>
      role.seedCode === 'onboarding-compliance'
        ? {
            ...role,
            seedVersion: 1,
            permissionKeys: role.permissionKeys.filter(
              (key) =>
                key !== REVIEW &&
                key !== VIEW &&
                key !== DETAILS &&
                key !== CERT_VIEW &&
                key !== CERT_REVIEW &&
                key !== ISSUER_VIEW &&
                key !== TYPE_VIEW,
            ),
          }
        : role,
    );
    await seedRoles(v1).execute(system, {});
    const before = roleOf('platform', 'onboarding-compliance');
    expect(before.permissionKeys).not.toContain(REVIEW);
    const viewerBefore = roleOf('platform', 'viewer');
    fakes.audits.length = 0;

    await expect(seedRoles().execute(system, {})).resolves.toEqual({
      ok: true,
      value: { created: 0, upgraded: 1 },
    });

    expect(roleOf('platform', 'onboarding-compliance')).toMatchObject({
      id: before.id,
      seedVersion: 7,
      permissionKeys: [
        ...before.permissionKeys,
        REVIEW,
        VIEW,
        DETAILS,
        CERT_VIEW,
        CERT_REVIEW,
        ISSUER_VIEW,
        TYPE_VIEW,
      ].sort(),
    });
    expect(roleOf('platform', 'viewer')).toEqual(viewerBefore);
    expect(fakes.audits).toEqual([
      {
        ...RoleSeedApplied.entry(before.id, {
          before: { seedVersion: 1 },
          after: {
            seedVersion: 7,
            addedKeys: [
              REVIEW,
              VIEW,
              DETAILS,
              CERT_VIEW,
              CERT_REVIEW,
              ISSUER_VIEW,
              TYPE_VIEW,
            ].sort(),
            removedKeys: [],
          },
        }),
        actor: 'system',
        marketId: code,
      },
    ]);
  });

  it('upgrades viewer from version 1 to 14: adds assistant.settings.view, certification.product-certificate.view, certification.claim-policy.view, certification.type.view, certification.seller-certificate.view, catalog.product.view, sellers.seller.view, pricing.price-hold.view, ordering.order.view, shipping.flat-fee.view, commission-payouts.settlement.view, payments.connected-account.view and notifications.support-contact.view, one seed-applied row, other roles untouched', async () => {
    const VIEW = 'sellers.seller.view';
    const HOLDS = 'pricing.price-hold.view';
    const ORDERS = 'ordering.order.view';
    const SHIPPING = 'shipping.flat-fee.view';
    const SETTLEMENT = 'commission-payouts.settlement.view';
    const PAYMENTS = 'payments.connected-account.view';
    const CATALOG = 'catalog.product.view';
    const SUPPORT = 'notifications.support-contact.view';
    const CERT = 'certification.seller-certificate.view';
    const TYPES = 'certification.type.view';
    const POLICIES = 'certification.claim-policy.view';
    const PRODUCT_CERTS = 'certification.product-certificate.view';
    const ASSISTANT = 'assistant.settings.view';
    // The previous build's definition: version 1 without the sellers, pricing and catalog keys.
    const v1 = seedWith((role) =>
      role.seedCode === 'viewer'
        ? {
            ...role,
            seedVersion: 1,
            permissionKeys: role.permissionKeys.filter(
              (k) =>
                k !== VIEW &&
                k !== HOLDS &&
                k !== CATALOG &&
                k !== ORDERS &&
                k !== SHIPPING &&
                k !== SETTLEMENT &&
                k !== PAYMENTS &&
                k !== SUPPORT &&
                k !== CERT &&
                k !== TYPES &&
                k !== POLICIES &&
                k !== PRODUCT_CERTS &&
                k !== ASSISTANT,
            ),
          }
        : role,
    );
    await seedRoles(v1).execute(system, {});
    const before = roleOf('platform', 'viewer');
    expect(before.permissionKeys).not.toContain(VIEW);
    const complianceBefore = roleOf('platform', 'onboarding-compliance');
    fakes.audits.length = 0;

    await expect(seedRoles().execute(system, {})).resolves.toEqual({
      ok: true,
      value: { created: 0, upgraded: 1 },
    });

    expect(roleOf('platform', 'viewer')).toMatchObject({
      id: before.id,
      seedVersion: 14,
      permissionKeys: [
        ...before.permissionKeys,
        ASSISTANT,
        CERT,
        TYPES,
        POLICIES,
        PRODUCT_CERTS,
        CATALOG,
        HOLDS,
        VIEW,
        ORDERS,
        SHIPPING,
        SETTLEMENT,
        PAYMENTS,
        SUPPORT,
      ].sort(),
    });
    expect(roleOf('platform', 'onboarding-compliance')).toEqual(complianceBefore);
    expect(fakes.audits).toEqual([
      {
        ...RoleSeedApplied.entry(before.id, {
          before: { seedVersion: 1 },
          after: {
            seedVersion: 14,
            addedKeys: [
              ASSISTANT,
              CERT,
              TYPES,
              POLICIES,
              PRODUCT_CERTS,
              CATALOG,
              ORDERS,
              SHIPPING,
              SETTLEMENT,
              PAYMENTS,
              SUPPORT,
              HOLDS,
              VIEW,
            ].sort(),
            removedKeys: [],
          },
        }),
        actor: 'system',
        marketId: code,
      },
    ]);
  });

  it('upgrades catalogue-moderator from version 1 to 8: adds the catalog keys, certification.claim-policy.view, certification.product-certificate.view, certification.type.view, pricing.price-hold.view and sellers.seller.view only, one seed-applied row, other roles untouched (I-1a)', async () => {
    const EDIT = 'catalog.platform-product.edit';
    // The previous build's definition: version 1 with the identity key only.
    const v1 = seedWith((role) =>
      role.seedCode === 'catalogue-moderator'
        ? { ...role, seedVersion: 1, permissionKeys: ['identity.seller-access.view'] }
        : role,
    );
    await seedRoles(v1).execute(system, {});
    const before = roleOf('platform', 'catalogue-moderator');
    expect([before.seedVersion, before.permissionKeys]).toEqual([
      1,
      ['identity.seller-access.view'],
    ]);
    // Copies, so an in-place change of a stored role would show.
    const others = [...fakes.roles.values()]
      .filter((r) => r.marketId === market.marketId && r.id !== before.id)
      .map((r) => ({ ...r, permissionKeys: [...r.permissionKeys] }));
    expect(others).toHaveLength(12);
    fakes.audits.length = 0;

    await expect(seedRoles().execute(system, {})).resolves.toEqual({
      ok: true,
      value: { created: 0, upgraded: 1 },
    });

    expect(roleOf('platform', 'catalogue-moderator')).toMatchObject({
      id: before.id,
      seedVersion: 8,
      permissionKeys: [
        EDIT,
        'catalog.product.approve',
        'catalog.product.view',
        'certification.claim-policy.view',
        'certification.product-certificate.view',
        'certification.type.view',
        'identity.seller-access.view',
        'pricing.price-hold.view',
        'sellers.seller.view',
      ],
    });
    // No other role of this Market gains the key or changes at all.
    for (const role of others) expect(fakes.roles.get(role.id)).toEqual(role);
    expect(fakes.audits).toEqual([
      {
        ...RoleSeedApplied.entry(before.id, {
          before: { seedVersion: 1 },
          after: {
            seedVersion: 8,
            addedKeys: [
              EDIT,
              'catalog.product.approve',
              'catalog.product.view',
              'certification.claim-policy.view',
              'certification.product-certificate.view',
              'certification.type.view',
              'pricing.price-hold.view',
              'sellers.seller.view',
            ],
            removedKeys: [],
          },
        }),
        actor: 'system',
        marketId: code,
      },
    ]);
    // Applied once.
    await expect(seedRoles().execute(system, {})).resolves.toEqual({
      ok: true,
      value: { created: 0, upgraded: 0 },
    });
  });

  it('upgrades a default role key by key, with one seed-applied row (Ali 2026-10-08)', async () => {
    await seedRoles().execute(system, {});
    const before = roleOf('seller', 'store-manager');
    fakes.audits.length = 0;
    const v2 = seedWith((role) =>
      role.seedCode === 'store-manager'
        ? {
            ...role,
            seedVersion: 5,
            permissionKeys: ['identity.team-member.view', 'identity.seller-access.view'].slice(
              0,
              1,
            ),
          }
        : role,
    );

    await expect(seedRoles(v2).execute(system, {})).resolves.toEqual({
      ok: true,
      value: { created: 0, upgraded: 1 },
    });

    expect(roleOf('seller', 'store-manager')).toMatchObject({
      id: before.id,
      seedVersion: 5,
      version: before.version + 1,
      permissionKeys: ['identity.team-member.view'],
    });
    expect(fakes.audits).toEqual([
      {
        ...RoleSeedApplied.entry(before.id, {
          before: { seedVersion: 4 },
          after: {
            seedVersion: 5,
            addedKeys: [],
            removedKeys: [
              'catalog.own-product.edit',
              'catalog.own-product.view',
              'certification.own-certificate.manage',
              'certification.own-certificate.view',
              'identity.seller-role.view',
            ],
          },
        }),
        actor: 'system',
        marketId: code,
      },
    ]);
    expect(logged('identity.seed-roles.upgraded')?.[0]).toMatchObject({
      roleId: before.id,
      fromSeedVersion: 4,
      seedVersion: 5,
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
      seedWith((role) => (role.seedCode === 'viewer' ? { ...role, seedVersion: 15 } : role)),
    ).execute(system, {});
    fakes.audits.length = 0;

    await expect(seedRoles().execute(system, {})).resolves.toEqual({
      ok: true,
      value: { created: 0, upgraded: 0 },
    });

    expect(roleOf('platform', 'viewer').seedVersion).toBe(15);
    expect(fakes.audits).toEqual([]);
    expect(logged('identity.seed-roles.stored-newer')?.[0]).toMatchObject({
      seedCode: 'viewer',
      storedSeedVersion: 15,
      seedVersion: 14,
    });
  });

  it('never changes a stored role of another kind under the same code', async () => {
    await seedRoles().execute(system, {});
    const stored = roleOf('seller', 'bookkeeper');
    fakes.roles.set(stored.id, { ...stored, kind: 'system' });
    fakes.audits.length = 0;

    await seedRoles(
      seedWith((role) => (role.seedCode === 'bookkeeper' ? { ...role, seedVersion: 2 } : role)),
    ).execute(system, {});

    expect(fakes.roles.get(stored.id)!.seedVersion).toBe(1);
    expect(fakes.audits).toEqual([]);
    expect(logged('identity.seed-roles.kind-mismatch')).toBeDefined();
  });

  it.each<[string, (role: SeededRole) => SeededRole, string]>([
    [
      'an unknown key',
      (r) => (r.seedCode === 'finance' ? { ...r, permissionKeys: ['identity.ledger.view'] } : r),
      'unknown-key',
    ],
    [
      'a key of the other scope',
      (r) =>
        r.seedCode === 'finance' ? { ...r, permissionKeys: ['identity.team-member.view'] } : r,
      'wrong-scope',
    ],
    [
      'a protected key (R11)',
      (r) =>
        r.seedCode === 'store-manager'
          ? { ...r, permissionKeys: ['identity.team-member.invite'] }
          : r,
      'protected-key',
    ],
    [
      'a protected key of another module',
      (r) =>
        r.seedCode === 'store-manager'
          ? { ...r, permissionKeys: ['sellers.business-identity.edit'] }
          : r,
      'protected-key',
    ],
    [
      'a key on a system role (R3)',
      (r) =>
        r.seedCode === 'seller-owner' ? { ...r, permissionKeys: ['identity.team-member.view'] } : r,
      'system-keys',
    ],
    [
      'more keys than one seed-applied row can list',
      (r) =>
        r.seedCode === 'viewer'
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
        r.seedCode === 'viewer'
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
        seedWith((role) => (role.seedCode === 'finance' ? { ...role, seedVersion: 4 } : role)),
        { roles: racing },
      ).execute(system, {}),
    ).resolves.toEqual({ ok: true, value: { created: 0, upgraded: 0 } });
    expect(fakes.audits).toEqual([]);
    expect(logged('identity.seed-roles.concurrent')).toBeDefined();
  });

  it('a refused audit row fails that role only: the run goes on and ends as seed.incomplete (PA W5; Mohammad 3)', async () => {
    await seedRoles().execute(system, {});
    fakes.audits.length = 0;
    const finance = roleOf('platform', 'finance');
    const refusing: AuditWriter = {
      record: (context, entry) =>
        entry.targetId === finance.id
          ? Promise.reject(new Error('audit refused'))
          : fakes.audit.record(context, entry),
    };

    await expect(
      seedRoles(
        seedWith((role) =>
          role.seedCode === 'finance' || role.seedCode === 'operations-support'
            ? { ...role, seedVersion: 4 }
            : role,
        ),
        { audit: refusing },
      ).execute(system, {}),
    ).resolves.toEqual({ ok: false, error: { code: 'seed.incomplete', failed: 1 } });
    // The other upgrade still applied, with its row; the failure is logged by code, no message.
    expect(roleOf('platform', 'operations-support').seedVersion).toBe(4);
    expect(fakes.audits.map((a) => [a.action, a.targetId])).toEqual([
      ['identity.role.seed-applied', roleOf('platform', 'operations-support').id],
    ]);
    expect(logged('identity.seed-roles.role-failed')?.[0]).toEqual({
      msg: 'identity.seed-roles.role-failed',
      errorName: 'Error',
      scope: 'platform',
      seedCode: 'finance',
      marketId: market.marketId,
      correlationId: system.correlationId,
    });
    expect(logged('identity.seed-roles.incomplete')?.[0]).toMatchObject({
      created: 0,
      upgraded: 1,
      failed: 1,
    });
  });

  it('one role that fails never keeps seller-owner from a new Market (Mohammad 3)', async () => {
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
    expect(roleOf('seller', 'seller-owner')).toMatchObject({ kind: 'system', seedVersion: 1 });
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
