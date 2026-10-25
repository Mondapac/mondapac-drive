import { Logger } from '@nestjs/common';
import { parseId, Temporal } from '@mondapac-drive/shared-kernel';
import type { Id, MarketContext, Result } from '@mondapac-drive/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac-drive/shared-kernel/testing';
import { fakeHashOf, IdentityFakes } from '../../../../../test/support/identity-fakes';
import {
  realEffectiveKeys,
  realPermissionRegistry,
} from '../../../../../test/support/permission-registry';
import {
  TEST_MARKETS,
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
} from '../../../../../test/support/test-config';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../../../../platform/market-context/tenant';
import type { UnitOfWork, UnitOfWorkOptions } from '../../../../platform/unit-of-work/unit-of-work';
import type { AccountState } from '../../domain/account';
import type { RoleState } from '../../domain/role';
import { CheckedInRoleSeed } from '../../infrastructure/seed/checked-in-role-seed';
import { MarketConfigIdentityPolicy } from '../../infrastructure/market-config-identity-policy';
import { AccountAuthorisationCheck } from '../access/account-authorisation-check';
import type { AccountRepository } from '../ports/account.repository';
import type { ThrottleKeys } from '../ports/session-secrets';
import { AssignAdminRole } from './assign-admin-role.use-case';
import { InviteAdmin } from './invite-admin.use-case';
import {
  ListPlatformRoles,
  type ListPlatformRolesInput,
  type PlatformRoleEntry,
} from './list-platform-roles.use-case';

// Identity slice 10a (identity design 5.3 `identity.platform-role.view`, 8.6 row 6; Ali's ruling
// 2026-10-09): the platform role catalogue with a `grantable` hint per role. The real gate,
// registry and checked-in seed; identity's stores as fakes. Both Market fixtures. The parity test
// runs `AssignAdminRole` and `InviteAdmin` for every role and every actor that may run them, and
// asserts that `grantable` is exactly "neither command refuses with `role.not-grantable` or a
// reach error (`role.unknown`)": the hint is the commands' own check, never a second one.

const START = Temporal.Instant.from('2026-10-09T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
/** Throttle keys in the clear: the counters are told apart by Market, population and address. */
const keys: ThrottleKeys = {
  account: (market, population, email) => Buffer.from(`${market.marketId}|${population}|${email}`),
  accountOrigin: (market, population, email, origin) =>
    Buffer.from(`${market.marketId}|${population}|${email}|${origin}`),
  origin: (market, origin) => Buffer.from(`${market.marketId}|${origin}`),
};
const ORIGIN = '203.0.113.9';

const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const n12 = (n: number) => String(n).padStart(12, '0');
const accountId = (n: number) => id<'Account'>(`01990000-0000-7000-8000-${n12(0xa000 + n)}`);
const SESSION_ID = id<'Session'>('01990000-0000-7000-8000-00000000f001');

const LEAD_ROLE = id<'Role'>('01990000-0000-7000-8000-00000000c0aa');
const NARROW_ROLE = id<'Role'>('01990000-0000-7000-8000-00000000c0bb');
const MIN_ROLE = id<'Role'>('01990000-0000-7000-8000-00000000c0cc');
const VIEWER_ROLE = id<'Role'>('01990000-0000-7000-8000-00000000c0dd');
const ELSEWHERE_ROLE = id<'Role'>('01990000-0000-7000-8000-00000000c0ee');
const MERCHANT_ID = id<'Merchant'>('01990000-0000-7000-8000-00000000b001');

const ROOT = accountId(1);
const LEAD = accountId(2);
const NARROW = accountId(3);
const VIEWER = accountId(4);
const SUPPORT = accountId(5);
const TARGET = accountId(6);
const OFF = accountId(7);
const COURIER = accountId(8);
const MERCHANT_ACCOUNT = accountId(9);

/** A custom role with protected keys (assign, invite) but not the system role. */
const LEAD_KEYS = [
  'delivery.delivery.cancel',
  'delivery.delivery.dispatch',
  'delivery.delivery.view',
  'dispatch.job.assign',
  'dispatch.job.view',
  'fleet.courier.decide',
  'fleet.courier.view',
  'fleet.document.review',
  'fleet.vehicle.manage',
  'identity.admin-account.disable',
  'identity.admin-account.invite',
  'identity.admin-account.reset-second-factor',
  'identity.admin-account.view',
  'identity.courier-account.disable',
  'identity.courier-account.invite',
  'identity.courier-account.view',
  'identity.platform-role.assign',
  'identity.platform-role.view',
  'tracking.map.view',
];
/** The keys of the custom viewer role: it holds less than every other admin role. */
const VIEWER_KEYS = ['identity.admin-account.view', 'identity.platform-role.view'];
/** Just enough to view, assign and invite: most roles hold a key it lacks. */
const NARROW_KEYS = [
  'identity.admin-account.invite',
  'identity.admin-account.view',
  'identity.platform-role.assign',
  'identity.platform-role.view',
];
const ENTRY_FIELDS = [
  'actions',
  'grantable',
  'kind',
  'name',
  'permissionCount',
  'permissionKeys',
  'roleId',
  'seedCode',
  'version',
];

describe.each(TEST_MARKETS)('ListPlatformRoles in market %s (slice 10a)', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const marketId = code as AccountState['marketId'];
  const otherCode = TEST_MARKETS.find((c) => c !== code)!;
  let fakes: IdentityFakes;
  let units: (UnitOfWorkOptions | undefined)[];
  let roles: Map<string, RoleState>;
  let platformRoleReads: number;

  const roleOf = (seedCode: string) => roles.get(`platform:${seedCode}`)!.id;
  const customRole = (
    roleId: Id<'Role'>,
    permissionKeys: string[],
    overrides: Partial<RoleState> = {},
  ): RoleState => ({
    id: roleId,
    marketId,
    scope: 'platform',
    kind: 'custom',
    seedCode: null,
    seedVersion: null,
    name: 'Custom role',
    permissionKeys: [...permissionKeys].sort(),
    version: 1,
    createdAt: START,
    ...overrides,
  });

  function setUp(options: { readonly accounts?: AccountRepository } = {}) {
    fakes = new IdentityFakes();
    units = [];
    platformRoleReads = 0;
    const clock = new FixedClock(START);
    const unitOfWork: UnitOfWork = {
      run: <T, E>(
        m: MarketContext,
        work: () => Promise<Result<T, E>>,
        unitOptions?: UnitOfWorkOptions,
      ) => {
        units.push(unitOptions);
        return fakes.unitOfWork.run(m, work);
      },
      runOnce: (m, delivery, work, o) => fakes.unitOfWork.runOnce(m, delivery, work, o),
    };
    roles = new Map();
    new CheckedInRoleSeed().roles().forEach((seeded, n) => {
      const role: RoleState = {
        id: id<'Role'>(`01990000-0000-7000-8000-${n12(0xc000 + n)}`),
        marketId,
        scope: seeded.scope,
        kind: seeded.kind,
        seedCode: seeded.seedCode,
        seedVersion: seeded.seedVersion,
        permissionKeys: seeded.kind === 'system' ? [] : [...seeded.permissionKeys].sort(),
        version: 1,
        createdAt: START,
      };
      fakes.seedRole(role);
      roles.set(`${seeded.scope}:${seeded.seedCode}`, role);
    });
    fakes.seedRole(customRole(LEAD_ROLE, LEAD_KEYS));
    fakes.seedRole(customRole(NARROW_ROLE, NARROW_KEYS));
    fakes.seedRole(customRole(MIN_ROLE, ['identity.platform-role.view']));
    const viewer = customRole(VIEWER_ROLE, VIEWER_KEYS, { name: 'Viewer' });
    fakes.seedRole(viewer);
    roles.set('platform:viewer', viewer);
    // Never listed: a platform role of the other Market.
    fakes.seedRole(
      customRole(ELSEWHERE_ROLE, ['identity.platform-role.view'], {
        marketId: otherCode as AccountState['marketId'],
      }),
    );
    const account = (
      n: number,
      idOf: Id<'Account'>,
      population: AccountState['population'],
      status: AccountState['status'] = 'active',
    ) =>
      fakes.seedAccount({
        id: idOf,
        marketId,
        population,
        email: { typed: `A${n}@Example.com`, normalized: `a${n}@example.com` },
        displayName: `Account ${n}`,
        status,
        emailVerifiedAt: START,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf('x'), changedAt: START },
      });
    const admin = (
      n: number,
      idOf: Id<'Account'>,
      roleId: Id<'Role'>,
      status: AccountState['status'] = 'active',
    ) => {
      account(n, idOf, 'admin', status);
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(`01990000-0000-7000-8000-${n12(0xe100 + n)}`),
        marketId,
        accountId: idOf,
        roleId,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    };
    admin(1, ROOT, roleOf('platform-administrator'));
    admin(2, LEAD, LEAD_ROLE);
    admin(3, NARROW, NARROW_ROLE);
    admin(4, VIEWER, roleOf('viewer'));
    admin(5, SUPPORT, roleOf('dispatcher'));
    admin(6, TARGET, MIN_ROLE);
    admin(7, OFF, roleOf('viewer'), 'disabled');
    account(8, COURIER, 'courier');
    account(9, MERCHANT_ACCOUNT, 'merchant');

    const effectiveKeys = realEffectiveKeys();
    const permissions = realPermissionRegistry();
    const gate = createUseCaseGate(
      markets,
      new AccountAuthorisationCheck({
        unitOfWork,
        accounts: fakes.accountRepository,
        memberships: fakes.membershipRepository,
        merchants: fakes.merchantRepository,
        grants: fakes.grantReader,
        effectiveKeys,
      }),
    );
    const roleRepository = {
      ...fakes.roleRepository,
      platformRoles: (m: MarketContext) => {
        platformRoleReads += 1;
        return fakes.roleRepository.platformRoles(m);
      },
    };
    const common = {
      unitOfWork,
      accounts: fakes.accountRepository,
      roles: fakes.roleRepository,
      assignments: fakes.assignmentRepository,
      grants: fakes.grantReader,
      effectiveKeys,
      permissions,
      outbox: fakes.outbox,
      audit: fakes.audit,
      clock,
    };
    return {
      permissions,
      list: new ListPlatformRoles(gate, {
        unitOfWork,
        accounts: options.accounts ?? fakes.accountRepository,
        roles: roleRepository,
        assignments: fakes.assignmentRepository,
        grants: fakes.grantReader,
        effectiveKeys,
        permissions,
      }),
      assign: new AssignAdminRole(gate, common),
      invite: new InviteAdmin(gate, {
        ...common,
        throttles: fakes.throttleRepository,
        keys,
        invitations: fakes.invitationRepository,
        policy: new MarketConfigIdentityPolicy(markets),
        ids: new SequenceIdGenerator(clock),
      }),
    };
  }

  const as = (account: Id<'Account'>, population: 'admin' | 'merchant' | 'courier' = 'admin') =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: account,
        sessionId: SESSION_ID,
        merchantId: population === 'merchant' ? MERCHANT_ID : null,
      }),
      'platform-roles-0001',
    );

  async function catalogue(list: ListPlatformRoles, actor: Id<'Account'>) {
    const result = await list.execute(as(actor), {});
    if (!result.ok) throw new Error(`listed: ${result.error.code}`);
    return result.value.items;
  }
  const byId = (items: readonly PlatformRoleEntry[], roleId: Id<'Role'>) =>
    items.find((item) => item.roleId === roleId)!;

  it('lists the Market’s platform roles by id, with exactly the declared fields', async () => {
    const { list, permissions } = setUp();

    const items = await catalogue(list, ROOT);

    const platform = [...roles.values()].filter((r) => r.scope === 'platform').map((r) => r.id);
    const expected = [...platform, LEAD_ROLE, NARROW_ROLE, MIN_ROLE].sort();
    expect(platform).toContain(VIEWER_ROLE);
    expect(items.map((item) => item.roleId)).toEqual(expected);
    for (const item of items) expect(Object.keys(item).sort()).toEqual(ENTRY_FIELDS);
    expect(byId(items, roleOf('platform-administrator'))).toMatchObject({
      roleId: roleOf('platform-administrator'),
      kind: 'system',
      seedCode: 'platform-administrator',
      // The system role confers every key of its scope (R3).
      permissionCount: permissions.keysOf('platform').size,
      grantable: true,
    });
    expect(byId(items, roleOf('operator'))).toMatchObject({
      roleId: roleOf('operator'),
      kind: 'default',
      seedCode: 'operator',
      permissionCount: 11,
      grantable: true,
    });
    expect(byId(items, roleOf('operator')).name).toBeNull();
    expect(byId(items, roleOf('operator')).permissionKeys).toHaveLength(11);
    expect(byId(items, LEAD_ROLE)).toMatchObject({
      kind: 'custom',
      seedCode: null,
      name: 'Custom role',
    });
    // Only the read-only unit of the gate and the one of the read (ADR-0025).
    expect(units).toEqual([{ readOnly: true }, { readOnly: true }]);
  });

  it('logs the outcome with counts and the correlation id only: no key, role id or seed code', async () => {
    const { list } = setUp();
    const spy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      await catalogue(list, LEAD);
      const line = spy.mock.calls
        .map(([entry]) => entry as Record<string, unknown>)
        .find((entry) => entry.msg === 'identity.list-platform-roles');
      expect(line).toEqual({
        msg: 'identity.list-platform-roles',
        outcome: 'platform-roles.listed',
        roles: 7,
        grantable: expect.any(Number) as number,
        marketId: code,
        correlationId: 'platform-roles-0001',
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('never lists a merchant or courier role or another Market’s role, and takes no parameter', async () => {
    const { list } = setUp();

    const ids = (await catalogue(list, ROOT)).map((item) => item.roleId as string);

    const populationRoles = [...roles.values()]
      .filter((r) => r.scope !== 'platform')
      .map((r) => r.id);
    expect(populationRoles).toHaveLength(2);
    for (const absent of [...populationRoles, ELSEWHERE_ROLE]) {
      expect(ids).not.toContain(absent);
    }
    for (const input of [
      { scope: 'merchant' },
      { merchantId: MERCHANT_ID },
      { scope: 'platform' },
    ]) {
      const refused = await list.execute(as(ROOT), input as unknown as ListPlatformRolesInput);
      expect(refused).toEqual({
        ok: false,
        error: {
          code: 'validation.failed',
          fields: Object.keys(input).map((path) => ({ path, code: 'unknown' })),
        },
      });
    }
  });

  it('answers grantable per actor: the system holder every role, others by the policy', async () => {
    const { list } = setUp();

    const root = await catalogue(list, ROOT);
    const lead = await catalogue(list, LEAD);
    const viewer = await catalogue(list, VIEWER);

    expect(root.every((item) => item.grantable)).toBe(true);
    // Not the system role (R3); not a role with a protected key without it (R11).
    expect(byId(lead, roleOf('platform-administrator')).grantable).toBe(false);
    expect(byId(lead, LEAD_ROLE).grantable).toBe(false);
    expect(byId(lead, roleOf('dispatcher')).grantable).toBe(true);
    // A key the actor lacks (R1): the operator holds identity.merchant.view.
    expect(byId(lead, roleOf('operator')).grantable).toBe(false);
    // A hint about the role only: the viewer holds no assign or invite key (documented).
    expect(byId(viewer, roleOf('viewer')).grantable).toBe(true);
    expect(byId(viewer, MIN_ROLE).grantable).toBe(true);
    expect(byId(viewer, roleOf('operator')).grantable).toBe(false);
    expect(byId(viewer, roleOf('dispatcher')).grantable).toBe(false);
  });

  it('refuses an admin without identity.platform-role.view, a disabled admin, and the merchant and courier populations', async () => {
    const { list } = setUp();

    for (const [actor, population] of [
      [SUPPORT, 'admin'],
      [OFF, 'admin'],
      [MERCHANT_ACCOUNT, 'merchant'],
      [COURIER, 'courier'],
    ] as const) {
      const refused = await list.execute(as(actor, population), {});
      expect(refused).toEqual({ ok: false, error: { code: 'access.denied' } });
    }
    expect(platformRoleReads).toBe(0);
  });

  it('reads the actor first: one disabled after the gate is refused before any role is read', async () => {
    // The gate reads the fake store; the read's own unit sees the actor disabled meanwhile.
    const disabledInUnit: AccountRepository = {
      ...new IdentityFakes().accountRepository,
      findById: (m, accountIdOf) => {
        const state = fakes.accounts.get(accountIdOf);
        if (state !== undefined) fakes.accounts.set(accountIdOf, { ...state, status: 'disabled' });
        return fakes.accountRepository.findById(m, accountIdOf);
      },
    };
    const { list } = setUp({ accounts: disabledInUnit });

    const refused = await list.execute(as(ROOT), {});

    expect(refused).toEqual({ ok: false, error: { code: 'access.denied' } });
    expect(platformRoleReads).toBe(0);
  });

  describe('parity with AssignAdminRole and InviteAdmin (Hassan, 10a)', () => {
    const GRANT_REFUSALS = new Set(['role.not-grantable', 'role.unknown']);

    it.each([
      ['the system holder', ROOT],
      ['a custom role with protected keys', LEAD],
      ['a narrow custom role', NARROW],
    ])('grantable equals the commands’ answer for %s', async (_label, actor) => {
      const { list } = setUp();
      const items = await catalogue(list, actor);
      const seen = new Set<boolean>();

      for (const item of items) {
        // A fresh store per role, so an earlier assignment never changes the next answer.
        const { assign, invite } = setUp();
        const assigned = await assign.execute(as(actor), {
          accountId: TARGET,
          roleId: item.roleId,
        });
        const invited = await invite.execute(as(actor), {
          origin: ORIGIN,
          email: 'parity@example.com',
          roleId: item.roleId,
        });
        const assignRefused = !assigned.ok && GRANT_REFUSALS.has(assigned.error.code);
        const inviteRefused = !invited.ok && GRANT_REFUSALS.has(invited.error.code);
        // Every other answer is a success: the fixtures reach the grant step for every role.
        if (!assigned.ok) expect(GRANT_REFUSALS).toContain(assigned.error.code);
        if (!invited.ok) expect(GRANT_REFUSALS).toContain(invited.error.code);

        expect({ roleId: item.roleId, grantable: item.grantable }).toEqual({
          roleId: item.roleId,
          grantable: !assignRefused,
        });
        expect(item.grantable).toBe(!inviteRefused);
        seen.add(item.grantable);
      }
      // The system holder grants all; the others see both answers.
      expect([...seen].sort()).toEqual(actor === ROOT ? [true] : [false, true]);
    });

    it('a merchant or courier role id is out of reach for both commands, as the catalogue never shows it', async () => {
      const { assign, invite } = setUp();
      const merchantRole = roles.get('merchant:merchant')!.id;
      const courierRole = roles.get('courier:courier')!.id;

      for (const roleId of [merchantRole, courierRole, ELSEWHERE_ROLE]) {
        const assigned = await assign.execute(as(ROOT), { accountId: TARGET, roleId });
        const invited = await invite.execute(as(ROOT), {
          origin: ORIGIN,
          email: 'x@example.com',
          roleId,
        });
        expect([assigned, invited]).toEqual([
          { ok: false, error: { code: 'role.unknown' } },
          { ok: false, error: { code: 'role.unknown' } },
        ]);
      }
    });
  });
});
