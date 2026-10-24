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
import { AccountAuthorisationCheck } from '../access/account-authorisation-check';
import type { RoleEditorDependencies } from '../roles/role-editor';
import { ListPlatformRoles } from './list-platform-roles.use-case';
import { CreatePlatformRole } from './create-platform-role.use-case';
import { DeletePlatformRole } from './delete-platform-role.use-case';
import { EditPlatformRole } from './edit-platform-role.use-case';

// Identity slice 10 (identity design 5.3, 5.4 R1 to R3, R5, R7, R9 to R11, 2.3): the role editor
// of the platform scope (Drive's only custom-role scope) and its catalogue hints. The real gate, registry and checked-in seed; identity's
// stores as fakes. Both Market fixtures. The parity tests run every command for every row and
// three actors and assert that the catalogue's hint is the command's own answer.

const START = Temporal.Instant.from('2026-10-09T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const n12 = (n: number) => String(n).padStart(12, '0');
const accountId = (n: number) => id<'Account'>(`01990000-0000-7000-8000-${n12(0xa000 + n)}`);
const roleIdOf = (n: number) => id<'Role'>(`01990000-0000-7000-8000-${n12(0xc800 + n)}`);
const SESSION_ID = id<'Session'>('01990000-0000-7000-8000-00000000f001');
const MERCHANT_ID = id<'Merchant'>('01990000-0000-7000-8000-00000000b001');

const ROOT = accountId(1);
const LEAD = accountId(2);
const NARROW = accountId(3);
const VIEWER = accountId(4);
const HOLDER = accountId(5);
const DISABLED = accountId(6);
const MERCHANT_ACCOUNT = accountId(11);
const COURIER = accountId(12);

const LEAD_ROLE = roleIdOf(1);
const NARROW_ROLE = roleIdOf(2);
const HIGH_ROLE = roleIdOf(3);
const HELD_ROLE = roleIdOf(4);

/** Created by a Platform Administrator, so they may hold the protected editor keys. */
const LEAD_KEYS = [
  'identity.courier-account.view',
  'identity.platform-role.create',
  'identity.platform-role.delete',
  'identity.platform-role.edit',
  'identity.platform-role.view',
  'identity.merchant.view',
];
const NARROW_KEYS = [
  'identity.platform-role.create',
  'identity.platform-role.view',
  'identity.merchant.view',
];
/** A role that outranks LEAD: it holds a key LEAD lacks. */
const HIGH_KEYS = ['identity.courier-account.disable', 'identity.merchant.view'];

const NAME_CANARY = 'Canary Röle 9f3a';

describe.each(TEST_MARKETS)('role editor in market %s (slice 10)', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const marketId = code as AccountState['marketId'];
  const otherCode = TEST_MARKETS.find((c) => c !== code)!;
  let fakes: IdentityFakes;
  let units: (UnitOfWorkOptions | undefined)[];
  let seeded: Map<string, RoleState>;
  let limit: number | null;

  const platformKeys = realPermissionRegistry().keysOf('platform');
  const registry = realPermissionRegistry();
  const unprotectedPlatform = registry
    .list('platform')
    .filter((d) => !d.protected)
    .map((d) => d.key);

  const roleOf = (scope: string, seedCode: string) => seeded.get(`${scope}:${seedCode}`)!.id;
  const custom = (
    roleId: Id<'Role'>,
    keys: string[],
    overrides: Partial<RoleState> = {},
  ): RoleState => ({
    id: roleId,
    marketId,
    scope: 'platform',
    kind: 'custom',
    seedCode: null,
    seedVersion: null,
    name: `Role ${roleId.slice(-4)}`,
    permissionKeys: [...keys].sort(),
    version: 1,
    createdAt: START,
    ...overrides,
  });

  function setUp() {
    fakes = new IdentityFakes();
    units = [];
    limit = 50;
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
    seeded = new Map();
    new CheckedInRoleSeed().roles().forEach((s, n) => {
      const role: RoleState = {
        id: id<'Role'>(`01990000-0000-7000-8000-${n12(0xc000 + n)}`),
        marketId,
        scope: s.scope,
        kind: s.kind,
        seedCode: s.seedCode,
        seedVersion: s.seedVersion,
        permissionKeys: s.kind === 'system' ? [] : [...s.permissionKeys].sort(),
        version: 1,
        createdAt: START,
      };
      fakes.seedRole(role);
      seeded.set(`${s.scope}:${s.seedCode}`, role);
    });
    fakes.seedRole(custom(LEAD_ROLE, LEAD_KEYS));
    fakes.seedRole(custom(NARROW_ROLE, NARROW_KEYS));
    fakes.seedRole(custom(HIGH_ROLE, HIGH_KEYS));
    fakes.seedRole(custom(HELD_ROLE, ['identity.merchant.view']));
    fakes.seedRole(
      custom(roleIdOf(90), ['identity.merchant.view'], {
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
    const assign = (n: number, idOf: Id<'Account'>, roleId: Id<'Role'>) =>
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(`01990000-0000-7000-8000-${n12(0xe100 + n)}`),
        marketId,
        accountId: idOf,
        roleId,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    const admin = (
      n: number,
      idOf: Id<'Account'>,
      roleId: Id<'Role'>,
      status: AccountState['status'] = 'active',
    ) => {
      account(n, idOf, 'admin', status);
      assign(n, idOf, roleId);
    };
    admin(1, ROOT, roleOf('platform', 'platform-administrator'));
    admin(2, LEAD, LEAD_ROLE);
    admin(3, NARROW, NARROW_ROLE);
    admin(4, VIEWER, roleOf('platform', 'operator'));
    admin(5, HOLDER, HELD_ROLE);
    admin(6, DISABLED, LEAD_ROLE, 'disabled');
    fakes.seedMerchant({
      id: MERCHANT_ID,
      marketId,
      name: 'Merchant',
      state: 'active',
      stateChangedAt: START,
      version: 1,
      createdAt: START,
    });
    account(11, MERCHANT_ACCOUNT, 'merchant');
    fakes.seedMembership({
      id: id<'MerchantMembership'>(`01990000-0000-7000-8000-${n12(0xe000 + 11)}`),
      marketId,
      accountId: MERCHANT_ACCOUNT,
      merchantId: MERCHANT_ID,
      state: 'active',
      removedAt: null,
      version: 1,
      createdAt: START,
    });
    assign(11, MERCHANT_ACCOUNT, roleOf('merchant', 'merchant'));
    account(12, COURIER, 'courier');
    assign(12, COURIER, roleOf('courier', 'courier'));

    const effectiveKeys = realEffectiveKeys();
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
    const deps: RoleEditorDependencies = {
      unitOfWork,
      accounts: fakes.accountRepository,
      roles: fakes.roleRepository,
      assignments: fakes.assignmentRepository,
      grants: fakes.grantReader,
      effectiveKeys,
      permissions: registry,
      policy: { customRoleLimit: () => limit },
      outbox: fakes.outbox,
      audit: fakes.audit,
      clock,
      ids: new SequenceIdGenerator(clock),
    };
    const readDeps = { ...deps };
    return {
      createPlatform: new CreatePlatformRole(gate, deps),
      editPlatform: new EditPlatformRole(gate, deps),
      deletePlatform: new DeletePlatformRole(gate, deps),
      listPlatform: new ListPlatformRoles(gate, readDeps),
    };
  }

  const asAdmin = (account: Id<'Account'>) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: account,
        sessionId: SESSION_ID,
        merchantId: null,
      }),
      'role-editor-0001',
    );
  const asMerchant = () =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'merchant',
        accountId: MERCHANT_ACCOUNT,
        sessionId: SESSION_ID,
        merchantId: MERCHANT_ID,
      }),
      'role-editor-0002',
    );
  const asCourier = () =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'courier',
        accountId: COURIER,
        sessionId: SESSION_ID,
        merchantId: null,
      }),
      'role-editor-0003',
    );
  const stored = (roleId: Id<'Role'>) => fakes.roles.get(roleId);
  const written = () => ({ events: fakes.events.length, audits: fakes.audits.length });

  describe('create (platform)', () => {
    it('creates a custom role for the Platform Administrator: row, event and audit row', async () => {
      const { createPlatform } = setUp();
      const keys = ['identity.platform-role.view', 'identity.admin-account.invite'];

      const result = await createPlatform.execute(asAdmin(ROOT), {
        name: `  ${NAME_CANARY}  `,
        permissionKeys: keys,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.code).toBe('role.created');
      const row = stored(result.value.roleId)!;
      expect(row).toMatchObject({
        scope: 'platform',
        kind: 'custom',
        name: NAME_CANARY,
        permissionKeys: [...keys].sort(),
        version: 1,
        marketId,
      });
      expect(fakes.events).toHaveLength(1);
      expect(fakes.events[0]).toMatchObject({
        type: 'identity.role-created.v1',
        aggregateId: result.value.roleId,
        payload: {
          roleId: result.value.roleId,
          scope: 'platform',
          addedKeys: [...keys].sort(),
          removedKeys: [],
        },
      });
      expect(fakes.audits).toHaveLength(1);
      expect(fakes.audits[0]).toMatchObject({
        action: 'identity.role.created',
        actor: 'authenticated',
        marketId: code,
      });
      // R5: the name has no path into an event or an audit row.
      expect(JSON.stringify([fakes.events, fakes.audits])).not.toContain('Canary');
      // One serializable write unit after the gate's read-only unit.
      expect(units).toEqual([{ readOnly: true }, { isolation: 'serializable' }]);
    });

    it.each([
      ['an empty name', '   ', 'length'],
      ['a name over 80 characters', 'x'.repeat(81), 'length'],
      ['a control character', 'bad\u0007name', 'characters'],
      ['a direction override', 'bad‮name', 'characters'],
      ['a lone surrogate', 'bad\ud800name', 'characters'],
    ])('refuses %s with the rule and writes nothing', async (_n, name, rule) => {
      const { createPlatform } = setUp();

      const result = await createPlatform.execute(asAdmin(ROOT), { name, permissionKeys: [] });

      expect(result).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'name', code: rule }] },
      });
      expect(written()).toEqual({ events: 0, audits: 0 });
    });

    it.each([
      ['an unknown key', ['identity.nothing.here'], 'unknown'],
      ['a merchant key in platform scope', ['delivery.booking.view'], 'scope'],
      [
        'a repeated key',
        ['identity.platform-role.view', 'identity.platform-role.view'],
        'duplicate',
      ],
      ['a non-string element', [42], 'format'],
      ['not an array', 'identity.platform-role.view', 'format'],
    ])('refuses %s (R2, R7) without echoing it', async (_n, permissionKeys, rule) => {
      const { createPlatform } = setUp();

      const result = await createPlatform.execute(asAdmin(ROOT), {
        name: 'Valid',
        permissionKeys: permissionKeys as never,
      });

      expect(result).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'permissionKeys', code: rule }] },
      });
      expect(JSON.stringify(result)).not.toContain('nothing');
      expect(written()).toEqual({ events: 0, audits: 0 });
    });

    it('refuses more than 40 keys (the audit row budget)', async () => {
      const { createPlatform } = setUp();
      // Fewer platform keys exist than 41: the cap is checked on the raw list.
      const many = Array.from({ length: 41 }, () => 'identity.platform-role.view');
      const result = await createPlatform.execute(asAdmin(ROOT), {
        name: 'Many',
        permissionKeys: many,
      });
      expect(result.ok).toBe(false);
      expect(written()).toEqual({ events: 0, audits: 0 });
    });

    it('refuses a key the actor lacks and a protected key without the system role (R1, R11)', async () => {
      const { createPlatform } = setUp();

      // LEAD lacks courier-account.disable (unprotected; it holds the editor keys and views only).
      const lacks = await createPlatform.execute(asAdmin(LEAD), {
        name: 'A',
        permissionKeys: ['identity.courier-account.disable'],
      });
      // LEAD holds identity.platform-role.create, which is protected: it may not hand it on.
      const protectedKey = await createPlatform.execute(asAdmin(LEAD), {
        name: 'B',
        permissionKeys: ['identity.platform-role.create'],
      });
      const fine = await createPlatform.execute(asAdmin(LEAD), {
        name: 'C',
        permissionKeys: ['identity.merchant.view'],
      });

      expect(lacks).toEqual({ ok: false, error: { code: 'role.not-grantable' } });
      expect(protectedKey).toEqual({ ok: false, error: { code: 'role.not-grantable' } });
      expect(fine.ok).toBe(true);
    });

    it('refuses a taken name, case-insensitively and NFC-normalised (M10), and per owner only', async () => {
      const { createPlatform } = setUp();
      const first = await createPlatform.execute(asAdmin(ROOT), {
        name: 'Café Team',
        permissionKeys: [],
      });
      const clash = await createPlatform.execute(asAdmin(ROOT), {
        name: 'CAFÉ team',
        permissionKeys: [],
      });
      const other = await createPlatform.execute(asAdmin(ROOT), {
        name: 'Another',
        permissionKeys: [],
      });

      expect(first.ok).toBe(true);
      expect(clash).toEqual({ ok: false, error: { code: 'role.name-taken' } });
      expect(other.ok).toBe(true);
    });

    it('enforces the Market limit, and fails closed while the Market sets none (2.3)', async () => {
      const { createPlatform } = setUp();
      limit = 2;
      // The fixtures already hold 4 custom platform roles: over the limit already.
      const over = await createPlatform.execute(asAdmin(ROOT), {
        name: 'Over',
        permissionKeys: [],
      });
      limit = 5;
      const under = await createPlatform.execute(asAdmin(ROOT), {
        name: 'Under',
        permissionKeys: [],
      });
      const full = await createPlatform.execute(asAdmin(ROOT), {
        name: 'Full',
        permissionKeys: [],
      });
      limit = null;
      const none = await createPlatform.execute(asAdmin(ROOT), {
        name: 'None',
        permissionKeys: [],
      });

      expect(over).toEqual({ ok: false, error: { code: 'role.limit' } });
      expect(under.ok).toBe(true);
      expect(full).toEqual({ ok: false, error: { code: 'role.limit' } });
      expect(none).toEqual({ ok: false, error: { code: 'access.unavailable' } });
    });

    it('refuses an admin without the key, a disabled admin, and every other population', async () => {
      const { createPlatform } = setUp();
      const input = { name: 'X', permissionKeys: [] };

      for (const context of [asAdmin(VIEWER), asAdmin(DISABLED), asMerchant(), asCourier()]) {
        const result = await createPlatform.execute(context, input);
        expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
      }
      expect(written()).toEqual({ events: 0, audits: 0 });
    });

    it('refuses an actor demoted after the gate: the unit reads the actor again', async () => {
      const { createPlatform } = setUp();
      fakes.roles.set(LEAD_ROLE, custom(LEAD_ROLE, ['identity.merchant.view']));

      const result = await createPlatform.execute(asAdmin(LEAD), {
        name: 'Late',
        permissionKeys: [],
      });

      expect(result).toEqual({ ok: false, error: { code: 'access.denied' } });
    });
  });

  describe('edit and delete (platform)', () => {
    it('edits a custom role: name and keys, with the added and removed keys in the event and the audit row', async () => {
      const { editPlatform } = setUp();

      const result = await editPlatform.execute(asAdmin(ROOT), {
        roleId: HIGH_ROLE,
        name: NAME_CANARY,
        permissionKeys: ['identity.merchant.view', 'identity.admin-account.invite'],
      });

      expect(result).toEqual({ ok: true, value: { code: 'role.updated', roleId: HIGH_ROLE } });
      expect(stored(HIGH_ROLE)).toMatchObject({
        name: NAME_CANARY,
        version: 2,
        permissionKeys: ['identity.admin-account.invite', 'identity.merchant.view'],
      });
      expect(fakes.events[0]).toMatchObject({
        type: 'identity.role-updated.v1',
        payload: {
          addedKeys: ['identity.admin-account.invite'],
          removedKeys: ['identity.courier-account.disable'],
        },
      });
      expect(fakes.audits[0]).toMatchObject({
        action: 'identity.role.updated',
        after: { renamed: true, addedKeys: ['identity.admin-account.invite'] },
      });
      expect(JSON.stringify([fakes.events, fakes.audits])).not.toContain('Canary');
    });

    it('answers role.unchanged and writes nothing for the same name and keys', async () => {
      const { editPlatform } = setUp();
      const role = stored(HIGH_ROLE)!;

      const result = await editPlatform.execute(asAdmin(ROOT), {
        roleId: HIGH_ROLE,
        name: role.name!,
        permissionKeys: [...role.permissionKeys],
      });

      expect(result).toEqual({ ok: true, value: { code: 'role.unchanged', roleId: HIGH_ROLE } });
      expect(stored(HIGH_ROLE)!.version).toBe(1);
      expect(written()).toEqual({ events: 0, audits: 0 });
    });

    it('never edits or deletes a system or default role (R3, R10): role.read-only', async () => {
      const { editPlatform, deletePlatform } = setUp();
      for (const seedCode of ['platform-administrator', 'operator']) {
        const roleId = roleOf('platform', seedCode);
        const before = JSON.stringify(stored(roleId));
        expect(
          await editPlatform.execute(asAdmin(ROOT), { roleId, name: 'X', permissionKeys: [] }),
        ).toEqual({ ok: false, error: { code: 'role.read-only' } });
        expect(await deletePlatform.execute(asAdmin(ROOT), { roleId })).toEqual({
          ok: false,
          error: { code: 'role.read-only' },
        });
        expect(JSON.stringify(stored(roleId))).toBe(before);
      }
    });

    it('answers role.unknown for a missing role, a merchant role and another Market’s role (R9)', async () => {
      const { editPlatform, deletePlatform } = setUp();
      for (const roleId of [roleIdOf(99), roleOf('merchant', 'merchant'), roleIdOf(90)]) {
        expect(
          await editPlatform.execute(asAdmin(ROOT), { roleId, name: 'X', permissionKeys: [] }),
        ).toEqual({ ok: false, error: { code: 'role.unknown' } });
        expect(await deletePlatform.execute(asAdmin(ROOT), { roleId })).toEqual({
          ok: false,
          error: { code: 'role.unknown' },
        });
      }
    });

    it('refuses an actor that does not dominate the role, or adds a key it may not give (R1, R11)', async () => {
      const { editPlatform, deletePlatform } = setUp();
      const outranks = await editPlatform.execute(asAdmin(LEAD), {
        roleId: HIGH_ROLE,
        name: 'X',
        permissionKeys: ['identity.merchant.view'],
      });
      const del = await deletePlatform.execute(asAdmin(LEAD), { roleId: HIGH_ROLE });
      const protectedKey = await editPlatform.execute(asAdmin(LEAD), {
        roleId: HELD_ROLE,
        name: 'X',
        permissionKeys: ['identity.platform-role.edit'],
      });
      const heldNoMore = await editPlatform.execute(asAdmin(LEAD), {
        roleId: HELD_ROLE,
        name: 'Held',
        permissionKeys: ['identity.courier-account.view', 'identity.courier-account.disable'],
      });

      for (const result of [outranks, del, protectedKey, heldNoMore]) {
        expect(result).toEqual({ ok: false, error: { code: 'role.not-grantable' } });
      }
      expect(stored(HIGH_ROLE)!.version).toBe(1);
      expect(stored(HELD_ROLE)!.permissionKeys).toEqual(['identity.merchant.view']);
    });

    it('renames to a free name but not to a taken one; a change of case alone is fine', async () => {
      const { editPlatform } = setUp();
      const taken = await editPlatform.execute(asAdmin(ROOT), {
        roleId: HIGH_ROLE,
        name: stored(HELD_ROLE)!.name!.toUpperCase(),
        permissionKeys: [...stored(HIGH_ROLE)!.permissionKeys],
      });
      const recase = await editPlatform.execute(asAdmin(ROOT), {
        roleId: HIGH_ROLE,
        name: stored(HIGH_ROLE)!.name!.toUpperCase(),
        permissionKeys: [...stored(HIGH_ROLE)!.permissionKeys],
      });

      expect(taken).toEqual({ ok: false, error: { code: 'role.name-taken' } });
      expect(recase.ok).toBe(true);
    });

    it('deletes a custom role nobody holds, and refuses one a member holds (role.in-use)', async () => {
      const { deletePlatform } = setUp();

      const held = await deletePlatform.execute(asAdmin(ROOT), { roleId: HELD_ROLE });
      const free = await deletePlatform.execute(asAdmin(ROOT), { roleId: HIGH_ROLE });

      expect(held).toEqual({ ok: false, error: { code: 'role.in-use' } });
      expect(stored(HELD_ROLE)).toBeDefined();
      expect(free).toEqual({ ok: true, value: { code: 'role.deleted', roleId: HIGH_ROLE } });
      expect(stored(HIGH_ROLE)).toBeUndefined();
      expect(fakes.events.at(-1)).toMatchObject({
        type: 'identity.role-deleted.v1',
        payload: { removedKeys: [...HIGH_KEYS].sort(), addedKeys: [] },
      });
      expect(fakes.audits.at(-1)).toMatchObject({
        action: 'identity.role.deleted',
        before: { removedKeys: [...HIGH_KEYS].sort() },
      });
    });

    it('logs outcome codes with the correlation id and never a name or a key', async () => {
      const { createPlatform } = setUp();
      const spy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      try {
        await createPlatform.execute(asAdmin(ROOT), {
          name: NAME_CANARY,
          permissionKeys: ['identity.platform-role.view'],
        });
        await createPlatform.execute(asAdmin(LEAD), {
          name: NAME_CANARY,
          permissionKeys: ['identity.platform-role.create'],
        });
        const lines = spy.mock.calls.map(([entry]) => entry as Record<string, unknown>);
        expect(lines.find((l) => l.msg === 'identity.create-platform-role')).toMatchObject({
          outcome: 'role.created',
          marketId: code,
          correlationId: 'role-editor-0001',
        });
        expect(JSON.stringify(lines)).not.toContain('Canary');
        expect(JSON.stringify(lines)).not.toMatch(/(platform-role|merchant)\.(view|create)/);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('the catalogue extended with names, keys and hints (10a, 10)', () => {
    it('shows the name of a custom role only, the keys it confers and every key of the scope', async () => {
      const { listPlatform } = setUp();

      const result = await listPlatform.execute(asAdmin(ROOT), {});

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const byId = (roleId: Id<'Role'>) => result.value.items.find((i) => i.roleId === roleId)!;
      expect(byId(LEAD_ROLE)).toMatchObject({
        kind: 'custom',
        name: stored(LEAD_ROLE)!.name,
        permissionKeys: [...LEAD_KEYS].sort(),
        permissionCount: LEAD_KEYS.length,
        version: 1,
      });
      const admin = byId(roleOf('platform', 'platform-administrator'));
      expect(admin.name).toBeNull();
      expect(admin.permissionKeys).toEqual([...platformKeys].sort());
      expect(result.value.keys.map((k) => k.key)).toEqual([...platformKeys].sort());
      expect(result.value.keys.every((k) => k.grantable)).toBe(true);
      // The merchant and courier scopes and other Markets are not reachable.
      for (const scope of ['merchant', 'courier']) {
        const roleId = roleOf(scope, scope);
        expect(result.value.items.some((i) => i.roleId === roleId)).toBe(false);
      }
      expect(result.value.items.some((i) => i.roleId === roleIdOf(90))).toBe(false);
    });

    it('asks which roles are held only for custom roles, never for the shared ones (Mojtaba)', async () => {
      const { listPlatform } = setUp();
      const spy = jest.spyOn(fakes.assignmentRepository, 'heldRoles');

      await listPlatform.execute(asAdmin(ROOT), {});

      expect(spy).toHaveBeenCalledTimes(1);
      for (const [, ids] of spy.mock.calls) {
        expect(ids.length).toBeGreaterThan(0);
        for (const roleId of ids) expect(stored(roleId)!.kind).toBe('custom');
      }
      const [, platformIds] = spy.mock.calls[0]!;
      expect([...platformIds].sort()).toEqual(
        [LEAD_ROLE, NARROW_ROLE, HIGH_ROLE, HELD_ROLE].sort(),
      );
      spy.mockRestore();
    });

    it('keeps the read-only units of the catalogue free of a transaction (ADR-0025)', async () => {
      const { listPlatform } = setUp();
      await listPlatform.execute(asAdmin(ROOT), {});
      expect(units.every((u) => u?.readOnly === true)).toBe(true);
    });
  });

  describe('parity: every hint is the command’s own answer (same verdict functions)', () => {
    const verdictOf = (result: { ok: boolean; error?: { code: string } }) =>
      result.ok ? { allowed: true, code: null } : { allowed: false, code: result.error!.code };

    it('edit and delete: every row of the platform catalogue, for three actors', async () => {
      for (const actor of [ROOT, LEAD, NARROW]) {
        const { listPlatform } = setUp();
        const listed = await listPlatform.execute(asAdmin(actor), {});
        if (!listed.ok) throw new Error('listed');
        expect(listed.value.items.length).toBeGreaterThan(5);
        const seen = new Set<string>();
        for (const row of listed.value.items) {
          const state = stored(row.roleId)!;
          // Each pair on a fresh store: a delete or an edit must not change the next answer.
          const edit = setUp().editPlatform;
          const keysNow = state.kind === 'custom' ? [...state.permissionKeys] : [];
          const nameNow = state.name ?? 'Parity';
          const editAnswer = await edit.execute(asAdmin(actor), {
            roleId: row.roleId,
            name: nameNow,
            permissionKeys: keysNow,
          });
          const del = setUp().deletePlatform;
          const deleteAnswer = await del.execute(asAdmin(actor), { roleId: row.roleId });
          expect(row.actions.edit).toEqual(verdictOf(editAnswer as never));
          expect(row.actions.delete).toEqual(verdictOf(deleteAnswer as never));
          seen.add(`edit:${row.actions.edit.code}`);
          seen.add(`delete:${row.actions.delete.code}`);
        }
        if (actor === ROOT) {
          expect([...seen]).toEqual(
            expect.arrayContaining(['edit:null', 'edit:role.read-only', 'delete:role.in-use']),
          );
        }
        if (actor === LEAD) {
          expect([...seen]).toEqual(expect.arrayContaining(['edit:role.not-grantable']));
        }
        if (actor === NARROW) {
          expect([...seen]).toEqual(expect.arrayContaining(['edit:access.denied']));
        }
      }
    });

    it('create: `grantable` per key is the create command’s answer, for three actors', async () => {
      for (const actor of [ROOT, LEAD, NARROW]) {
        const { listPlatform } = setUp();
        const listed = await listPlatform.execute(asAdmin(actor), {});
        if (!listed.ok) throw new Error('listed');
        let yes = 0;
        let no = 0;
        for (const key of listed.value.keys) {
          const { createPlatform } = setUp();
          const answer = await createPlatform.execute(asAdmin(actor), {
            name: 'Probe',
            permissionKeys: [key.key],
          });
          expect(answer.ok).toBe(key.grantable);
          if (!answer.ok) expect(answer.error.code).toBe('role.not-grantable');
          if (key.grantable) yes += 1;
          else no += 1;
        }
        // Both answers occur for the two non-system actors; the system role may give all.
        expect(yes).toBeGreaterThan(0);
        if (actor === ROOT) expect(no).toBe(0);
        else expect(no).toBeGreaterThan(0);
        void unprotectedPlatform;
      }
    });
  });
});
