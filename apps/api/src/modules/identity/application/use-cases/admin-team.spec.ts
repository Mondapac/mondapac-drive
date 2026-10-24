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
import { parseEmailAddress } from '../../domain/email-address';
import type { InvitationState } from '../../domain/invitation';
import type { RoleState } from '../../domain/role';
import { openSession } from '../../domain/session';
import { CheckedInRoleSeed } from '../../infrastructure/seed/checked-in-role-seed';
import { MarketConfigIdentityPolicy } from '../../infrastructure/market-config-identity-policy';
import { AccountAuthorisationCheck } from '../access/account-authorisation-check';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { ThrottleKeys } from '../ports/session-secrets';
import { inviterMayStillGrant } from '../roles/granting';
import { AssignAdminRole } from './assign-admin-role.use-case';
import { DisableAdminAccount } from './disable-admin-account.use-case';
import { DisableCourierAccount } from './disable-courier-account.use-case';
import { EnableAdminAccount } from './enable-admin-account.use-case';
import { EnableCourierAccount } from './enable-courier-account.use-case';
import { InviteAdmin } from './invite-admin.use-case';
import { ResendAdminInvitation } from './resend-admin-invitation.use-case';
import { ResetOtherAdminSecondFactor } from './reset-other-admin-second-factor.use-case';
import { RevokeAdminInvitation } from './revoke-admin-invitation.use-case';

// Identity slices 8a-2 and 8b (identity design 3.1, 3.4, 3.6, 5.3 to 5.6; R1, R3, R11; HF8;
// Hassan I-2): an admin's role change, disabling and enabling admin and courier accounts, the
// admin-initiated second-factor reset, and admin invitations with an inviter. The real gate,
// registry and checked-in seed; identity's stores as fakes. Both Market fixtures.

const START = Temporal.Instant.from('2026-10-08T10:00:00Z');
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
/** A platform custom role of view keys only: the marketplace's seeded viewer, as Drive seeds none. */
const VIEWER_ROLE = id<'Role'>('01990000-0000-7000-8000-00000000c0bb');
const UNKNOWN_ROLE = id<'Role'>('01990000-0000-7000-8000-00000000c0cc');

const ROOT = accountId(1);
const ROOT2 = accountId(2);
const LEAD = accountId(3);
const VIEWER = accountId(4);
const SUPPORT = accountId(5);
const COURIER = accountId(6);
const MERCHANT_ACCOUNT = accountId(7);
const UNKNOWN = accountId(99);

/** A platform custom role with protected keys, as a future role editor could store (5.6). */
const LEAD_KEYS = [
  'delivery.delivery.cancel',
  'delivery.delivery.dispatch',
  'delivery.delivery.view',
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

describe.each(TEST_MARKETS)('admin team use cases in market %s (slices 8a-2, 8b)', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const marketId = code as AccountState['marketId'];
  let fakes: IdentityFakes;
  let units: (UnitOfWorkOptions | undefined)[];
  let roles: Map<string, RoleState>;
  let clock: FixedClock;
  /**
   * Runs once at the start of the next unit that is not read-only, after the gate's read-only
   * unit: a change that commits between the gate's check and the use case's own unit (C1).
   */
  let betweenGateAndUnit: (() => void | Promise<unknown>) | null;

  function setUp(options: { readonly withoutInvitationLifetime?: boolean } = {}) {
    fakes = new IdentityFakes();
    units = [];
    clock = new FixedClock(START);
    betweenGateAndUnit = null;
    const unitOfWork: UnitOfWork = {
      run: <T, E>(
        m: MarketContext,
        work: () => Promise<Result<T, E>>,
        options?: UnitOfWorkOptions,
      ) => {
        units.push(options);
        if (options?.readOnly !== true && betweenGateAndUnit !== null) {
          const change = betweenGateAndUnit;
          betweenGateAndUnit = null;
          return Promise.resolve(change()).then(() => fakes.unitOfWork.run(m, work));
        }
        return fakes.unitOfWork.run(m, work);
      },
      runOnce: (m, delivery, work, options) => fakes.unitOfWork.runOnce(m, delivery, work, options),
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
    fakes.seedRole({
      id: LEAD_ROLE,
      marketId,
      scope: 'platform',
      kind: 'custom',
      seedCode: null,
      seedVersion: null,
      name: 'Custom role',
      permissionKeys: LEAD_KEYS,
      version: 1,
      createdAt: START,
    });
    const viewer: RoleState = {
      id: VIEWER_ROLE,
      marketId,
      scope: 'platform',
      kind: 'custom',
      seedCode: null,
      seedVersion: null,
      name: 'Viewer',
      permissionKeys: VIEWER_KEYS,
      version: 1,
      createdAt: START,
    };
    fakes.seedRole(viewer);
    roles.set('platform:viewer', viewer);

    const account = (n: number, idOf: Id<'Account'>, population: AccountState['population']) =>
      fakes.seedAccount({
        id: idOf,
        marketId,
        population,
        email: { typed: `a${n}@example.com`, normalized: `a${n}@example.com` },
        displayName: `Account ${n}`,
        status: 'active',
        emailVerifiedAt: START,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf('x'), changedAt: START },
      });
    const admin = (n: number, idOf: Id<'Account'>, roleId: Id<'Role'>) => {
      account(n, idOf, 'admin');
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
    admin(2, ROOT2, roleOf('platform-administrator'));
    admin(3, LEAD, LEAD_ROLE);
    admin(4, VIEWER, roleOf('viewer'));
    admin(5, SUPPORT, roleOf('dispatcher'));
    account(6, COURIER, 'courier');
    account(7, MERCHANT_ACCOUNT, 'merchant');

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
    const common = {
      unitOfWork,
      accounts: fakes.accountRepository,
      roles: fakes.roleRepository,
      assignments: fakes.assignmentRepository,
      grants: fakes.grantReader,
      effectiveKeys,
      outbox: fakes.outbox,
      audit: fakes.audit,
      clock,
    };
    const status = {
      ...common,
      sessions: fakes.sessionRepository,
      challenges: fakes.challengeRepository,
    };
    const permissions = realPermissionRegistry();
    const base = new MarketConfigIdentityPolicy(markets);
    // A Market that configures no admin invitation lifetime: nothing could be dispatched.
    const policy: IdentityMarketPolicy =
      options.withoutInvitationLifetime === true
        ? Object.assign(Object.create(base) as IdentityMarketPolicy, {
            invitationLifetimeMinutes: () => null,
          })
        : base;
    const invitations = fakes.invitationRepository;
    return {
      assign: new AssignAdminRole(gate, { ...common, permissions }),
      disableAdmin: new DisableAdminAccount(gate, status),
      enableAdmin: new EnableAdminAccount(gate, status),
      disableCourier: new DisableCourierAccount(gate, status),
      enableCourier: new EnableCourierAccount(gate, status),
      resetFactor: new ResetOtherAdminSecondFactor(gate, {
        ...status,
        factors: fakes.factorRepository,
      }),
      invite: new InviteAdmin(gate, {
        ...common,
        throttles: fakes.throttleRepository,
        keys,
        permissions,
        invitations,
        policy,
        ids: new SequenceIdGenerator(clock),
      }),
      resend: new ResendAdminInvitation(gate, {
        ...common,
        permissions,
        invitations,
        throttles: fakes.throttleRepository,
        keys,
        policy,
      }),
      revoke: new RevokeAdminInvitation(gate, { ...common, invitations }),
      inviter: { ...common, permissions },
    };
  }

  const roleOf = (seedCode: string) => roles.get(`platform:${seedCode}`)!.id;
  const as = (account: Id<'Account'>) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: account,
        sessionId: SESSION_ID,
        merchantId: null,
      }),
      'admin-team-0001',
    );
  const roleIdOf = (account: Id<'Account'>) =>
    [...fakes.assignments.values()].find((a) => a.accountId === account)!.roleId;
  const statusOf = (account: Id<'Account'>) => fakes.accounts.get(account)!.status;
  const eventTypes = () => fakes.events.map((event) => event.type);
  const serializable = () => units.some((u) => u?.isolation === 'serializable');

  function seedSession(account: Id<'Account'>, n: number) {
    void fakes.sessionRepository.add(
      market,
      openSession({
        id: id<'Session'>(`01990000-0000-7000-8000-${n12(0xf100 + n)}`),
        marketId,
        accountId: account,
        population: fakes.accounts.get(account)!.population,
        transport: 'cookie',
        lifetime: { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 },
        now: START,
      }),
      new Uint8Array(32).fill(n),
    );
  }

  function seedChallenge(account: Id<'Account'>, n: number) {
    void fakes.challengeRepository.add(
      market,
      {
        id: id<'SignInChallenge'>(`01990000-0000-7000-8000-${n12(0xf200 + n)}`),
        marketId,
        accountId: account,
        purpose: 'second-factor',
        attempts: 0,
        credentialChangedAt: START,
        expiresAt: START.add({ minutes: 5 }),
        consumedAt: null,
        createdAt: START,
      },
      new Uint8Array(32).fill(100 + n),
    );
  }

  /** A factor of `account`: pending, active with its ten codes, or active and locked (HF2). */
  function seedFactor(
    account: Id<'Account'>,
    n: number,
    kind: 'pending' | 'active' | 'locked' = 'pending',
  ) {
    const active = kind !== 'pending';
    fakes.factors.set(account, {
      id: id<'SecondFactor'>(`01990000-0000-7000-8000-${n12(0xf300 + n)}`),
      marketId,
      accountId: account,
      state: active ? 'active' : 'pending',
      secretCiphertext: 'sealed',
      pendingSecretCiphertext: null,
      lastAcceptedStep: active ? 1 : null,
      activatedAt: active ? START : null,
      lockedAt: kind === 'locked' ? START : null,
      createdAt: START,
      recoveryCodes: active
        ? Array.from({ length: 10 }, (_, i) => ({
            position: i + 1,
            codeHash: new Uint8Array(32).fill(i + 1),
            usedAt: null,
          }))
        : [],
      version: 1,
    });
  }

  function seedInvitation(n: number, overrides: Partial<InvitationState> = {}): Id<'Invitation'> {
    const invitationId = id<'Invitation'>(`01990000-0000-7000-8000-${n12(0xf400 + n)}`);
    const email = parseEmailAddress(`invitee${n}@example.com`);
    if (!email.ok) throw new Error('bad email');
    fakes.invitations.set(invitationId, {
      id: invitationId,
      marketId,
      kind: 'admin',
      email: email.value,
      roleId: roleOf('viewer'),
      invitedByAccountId: ROOT,
      tokenHash: new Uint8Array(32).fill(7),
      expiresAt: START.add({ hours: 1 }),
      state: 'pending',
      decidedAt: null,
      acceptedAccountId: null,
      createdAt: START,
      version: 2,
      ...overrides,
    });
    return invitationId;
  }

  describe('AssignAdminRole (8a-2)', () => {
    it("changes an admin's role in one serializable unit, with its event and audit row", async () => {
      const { assign } = setUp();

      const result = await assign.execute(as(ROOT), {
        accountId: VIEWER,
        roleId: roleOf('dispatcher'),
      });

      expect(result).toEqual({
        ok: true,
        value: { code: 'role.assigned', accountId: VIEWER, roleId: roleOf('dispatcher') },
      });
      expect(roleIdOf(VIEWER)).toBe(roleOf('dispatcher'));
      const stored = [...fakes.assignments.values()].find((a) => a.accountId === VIEWER)!;
      expect(stored).toMatchObject({ assignedByAccountId: ROOT, assignedAt: START, version: 2 });
      expect(fakes.events).toEqual([
        expect.objectContaining({
          type: 'identity.account-role-changed.v1',
          payload: {
            accountId: VIEWER,
            scope: 'platform',
            previousRoleId: roleOf('viewer'),
            roleId: roleOf('dispatcher'),
          },
        }),
      ]);
      expect(fakes.audits).toEqual([
        expect.objectContaining({
          action: 'identity.account-role.changed',
          targetId: VIEWER,
          before: { roleId: roleOf('viewer') },
          after: { roleId: roleOf('dispatcher'), scope: 'platform' },
          actor: 'authenticated',
          marketId: code,
        }),
      ]);
      expect(serializable()).toBe(true);
    });

    it('answers role.unchanged for the role the admin holds, and writes nothing', async () => {
      const { assign } = setUp();

      await expect(
        assign.execute(as(ROOT), { accountId: VIEWER, roleId: roleOf('viewer') }),
      ).resolves.toEqual({
        ok: true,
        value: { code: 'role.unchanged', accountId: VIEWER, roleId: roleOf('viewer') },
      });
      expect(fakes.events).toEqual([]);
      expect(fakes.audits).toEqual([]);
    });

    it("never changes one's own role (member.self)", async () => {
      const { assign } = setUp();

      await expect(
        assign.execute(as(ROOT), { accountId: ROOT, roleId: roleOf('viewer') }),
      ).resolves.toEqual({ ok: false, error: { code: 'member.self' } });
      expect(roleIdOf(ROOT)).toBe(roleOf('platform-administrator'));
    });

    it('lets a custom role with the key act within its own keys only (R1, R3, R11)', async () => {
      const { assign } = setUp();

      // A target holding keys the actor lacks, and the system role's holder (R3).
      await expect(
        assign.execute(as(LEAD), { accountId: ROOT2, roleId: roleOf('viewer') }),
      ).resolves.toEqual({ ok: false, error: { code: 'member.outranks-actor' } });
      // A role with a protected key needs the system role (R11); the system role needs it (R3).
      for (const roleId of [LEAD_ROLE, roleOf('platform-administrator')]) {
        await expect(assign.execute(as(LEAD), { accountId: SUPPORT, roleId })).resolves.toEqual({
          ok: false,
          error: { code: 'role.not-grantable' },
        });
      }
      // A role whose keys the actor holds, on a target whose keys it holds.
      await expect(
        assign.execute(as(LEAD), { accountId: SUPPORT, roleId: roleOf('viewer') }),
      ).resolves.toMatchObject({ ok: true, value: { code: 'role.assigned' } });
      expect(roleIdOf(SUPPORT)).toBe(roleOf('viewer'));
    });

    it('refuses Operator to an admin without identity.merchant.view (I-1a)', async () => {
      const { assign } = setUp();
      expect(LEAD_KEYS).not.toContain('identity.merchant.view');
      expect(roles.get('platform:operator')!.permissionKeys).toContain('identity.merchant.view');

      // LEAD holds identity.platform-role.assign and every other key of the role, not this one.
      await expect(
        assign.execute(as(LEAD), { accountId: SUPPORT, roleId: roleOf('operator') }),
      ).resolves.toEqual({ ok: false, error: { code: 'role.not-grantable' } });
      expect(roleIdOf(SUPPORT)).toBe(roleOf('dispatcher'));
      expect(fakes.audits).toEqual([]);
      // A holder of the key (the system role) may grant it.
      await expect(
        assign.execute(as(ROOT), { accountId: SUPPORT, roleId: roleOf('operator') }),
      ).resolves.toMatchObject({ ok: true, value: { code: 'role.assigned' } });
    });

    it('makes another Platform Administrator, and demotes one while another remains', async () => {
      const { assign } = setUp();

      await expect(
        assign.execute(as(ROOT), { accountId: VIEWER, roleId: roleOf('platform-administrator') }),
      ).resolves.toMatchObject({ ok: true, value: { code: 'role.assigned' } });
      await expect(
        assign.execute(as(ROOT), { accountId: ROOT2, roleId: roleOf('viewer') }),
      ).resolves.toMatchObject({ ok: true, value: { code: 'role.assigned' } });
      expect(roleIdOf(ROOT2)).toBe(roleOf('viewer'));
    });

    it('refuses to demote the last active holder counted in the unit (HF8, AC 25)', async () => {
      // As a concurrent demotion of the actor would leave the count: only the target remains.
      const { assign } = setUpWithHolders([ROOT2]);

      await expect(
        assign.execute(as(ROOT), { accountId: ROOT2, roleId: roleOf('viewer') }),
      ).resolves.toEqual({ ok: false, error: { code: 'member.last-holder' } });
      expect(roleIdOf(ROOT2)).toBe(roleOf('platform-administrator'));
      expect(serializable()).toBe(true);
    });

    it('answers unknown, as for a missing id, for a non-admin account or a role out of reach (I-2)', async () => {
      const { assign } = setUp();

      for (const target of [UNKNOWN, COURIER, MERCHANT_ACCOUNT]) {
        await expect(
          assign.execute(as(ROOT), { accountId: target, roleId: roleOf('viewer') }),
        ).resolves.toEqual({ ok: false, error: { code: 'account.unknown' } });
      }
      // The merchant and courier system roles and a missing role: never an admin's.
      for (const roleId of [
        roles.get('merchant:merchant')!.id,
        roles.get('courier:courier')!.id,
        UNKNOWN_ROLE,
      ]) {
        await expect(assign.execute(as(ROOT), { accountId: VIEWER, roleId })).resolves.toEqual({
          ok: false,
          error: { code: 'role.unknown' },
        });
      }
      expect(fakes.events).toEqual([]);
    });

    it('denies an admin without identity.platform-role.assign at the gate', async () => {
      const { assign } = setUp();

      await expect(
        assign.execute(as(VIEWER), { accountId: SUPPORT, roleId: roleOf('viewer') }),
      ).resolves.toEqual({ ok: false, error: { code: 'access.denied' } });
    });
  });

  describe('disabling and enabling accounts (8b)', () => {
    it('disables an admin: credential lock first, every session revoked, every challenge void', async () => {
      const { disableAdmin } = setUp();
      seedSession(VIEWER, 1);
      seedSession(VIEWER, 2);
      seedSession(SUPPORT, 3);
      seedChallenge(VIEWER, 1);
      fakes.credentialLocks.length = 0;

      await expect(disableAdmin.execute(as(ROOT), { accountId: VIEWER })).resolves.toEqual({
        ok: true,
        value: { code: 'account.disabled', accountId: VIEWER, revokedSessions: 2 },
      });
      expect(fakes.credentialLocks[0]).toBe(VIEWER);
      expect(statusOf(VIEWER)).toBe('disabled');
      const sessions = [...fakes.sessions.values()].map((s) => s.session);
      expect(sessions.filter((s) => s.accountId === VIEWER).map((s) => s.revokedReason)).toEqual([
        'account-disabled',
        'account-disabled',
      ]);
      expect(sessions.find((s) => s.accountId === SUPPORT)!.revokedAt).toBeNull();
      expect([...fakes.challenges.values()]).toEqual([]);
      expect(eventTypes()).toEqual(['identity.account-disabled.v1']);
      expect(fakes.events[0]!.payload).toEqual({ accountId: VIEWER, population: 'admin' });
      expect(fakes.audits).toEqual([
        expect.objectContaining({
          action: 'identity.account.disabled',
          targetId: VIEWER,
          before: { status: 'active' },
          after: { status: 'disabled', population: 'admin' },
          actor: 'authenticated',
        }),
      ]);
      expect(serializable()).toBe(true);
    });

    it('enables a disabled admin again, and refuses a repeated change of either kind', async () => {
      const { disableAdmin, enableAdmin } = setUp();

      await disableAdmin.execute(as(ROOT), { accountId: VIEWER });
      await expect(disableAdmin.execute(as(ROOT), { accountId: VIEWER })).resolves.toEqual({
        ok: false,
        error: { code: 'account.already-disabled' },
      });
      await expect(enableAdmin.execute(as(ROOT), { accountId: VIEWER })).resolves.toEqual({
        ok: true,
        value: { code: 'account.enabled', accountId: VIEWER, revokedSessions: 0 },
      });
      await expect(enableAdmin.execute(as(ROOT), { accountId: VIEWER })).resolves.toEqual({
        ok: false,
        error: { code: 'account.already-active' },
      });
      expect(statusOf(VIEWER)).toBe('active');
      expect(eventTypes()).toEqual(['identity.account-disabled.v1', 'identity.account-enabled.v1']);
    });

    it('a disabled admin is refused at the gate on its next call', async () => {
      const { disableAdmin, assign } = setUp();

      await disableAdmin.execute(as(ROOT), { accountId: LEAD });

      await expect(
        assign.execute(as(LEAD), { accountId: SUPPORT, roleId: roleOf('viewer') }),
      ).resolves.toEqual({ ok: false, error: { code: 'access.denied' } });
    });

    it("never disables oneself, a holder of more keys, or the system role's holder without it", async () => {
      const { disableAdmin } = setUp();

      await expect(disableAdmin.execute(as(ROOT), { accountId: ROOT })).resolves.toEqual({
        ok: false,
        error: { code: 'member.self' },
      });
      await expect(disableAdmin.execute(as(LEAD), { accountId: ROOT2 })).resolves.toEqual({
        ok: false,
        error: { code: 'member.outranks-actor' },
      });
      expect(statusOf(ROOT2)).toBe('active');
      await expect(disableAdmin.execute(as(LEAD), { accountId: SUPPORT })).resolves.toMatchObject({
        ok: true,
        value: { code: 'account.disabled' },
      });
    });

    it('disables a Platform Administrator while another remains, never the last (AC 25)', async () => {
      const { disableAdmin } = setUp();

      await expect(disableAdmin.execute(as(ROOT), { accountId: ROOT2 })).resolves.toMatchObject({
        ok: true,
        value: { code: 'account.disabled' },
      });
      // As a concurrent disable of the actor would leave the count: only the target remains.
      const { disableAdmin: again } = setUpWithHolders([ROOT2]);
      await expect(again.execute(as(ROOT), { accountId: ROOT2 })).resolves.toEqual({
        ok: false,
        error: { code: 'member.last-holder' },
      });
      expect(statusOf(ROOT2)).toBe('active');
    });

    it('disables and enables a courier under identity.courier-account.disable (Ali 14.1-2)', async () => {
      const { disableCourier, enableCourier } = setUp();
      seedSession(COURIER, 4);

      await expect(disableCourier.execute(as(SUPPORT), { accountId: COURIER })).resolves.toEqual({
        ok: true,
        value: { code: 'account.disabled', accountId: COURIER, revokedSessions: 1 },
      });
      expect(fakes.events[0]!.payload).toEqual({ accountId: COURIER, population: 'courier' });
      await expect(enableCourier.execute(as(SUPPORT), { accountId: COURIER })).resolves.toEqual({
        ok: true,
        value: { code: 'account.enabled', accountId: COURIER, revokedSessions: 0 },
      });
      await expect(disableCourier.execute(as(VIEWER), { accountId: COURIER })).resolves.toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
    });

    it('answers account.unknown for an id of another population, a merchant account or none', async () => {
      const { disableAdmin, disableCourier } = setUp();

      for (const target of [COURIER, MERCHANT_ACCOUNT, UNKNOWN]) {
        await expect(disableAdmin.execute(as(ROOT), { accountId: target })).resolves.toEqual({
          ok: false,
          error: { code: 'account.unknown' },
        });
      }
      for (const target of [VIEWER, MERCHANT_ACCOUNT, UNKNOWN]) {
        await expect(disableCourier.execute(as(ROOT), { accountId: target })).resolves.toEqual({
          ok: false,
          error: { code: 'account.unknown' },
        });
      }
      expect(statusOf(MERCHANT_ACCOUNT)).toBe('active');
      expect(fakes.events).toEqual([]);
    });
  });

  describe('ResetOtherAdminSecondFactor (8b)', () => {
    it("removes another admin's factor, revokes its sessions and voids its challenges", async () => {
      const { resetFactor } = setUp();
      seedFactor(VIEWER, 1);
      seedSession(VIEWER, 5);
      seedChallenge(VIEWER, 2);

      await expect(resetFactor.execute(as(ROOT), { accountId: VIEWER })).resolves.toEqual({
        ok: true,
        value: { code: 'second-factor.reset', accountId: VIEWER, revokedSessions: 1 },
      });
      expect(fakes.factors.has(VIEWER)).toBe(false);
      expect([...fakes.sessions.values()][0]!.session.revokedReason).toBe('second-factor-reset');
      expect([...fakes.challenges.values()]).toEqual([]);
      expect(eventTypes()).toEqual(['identity.second-factor-changed.v1']);
      expect(fakes.audits).toEqual([
        expect.objectContaining({
          action: 'identity.second-factor.reset',
          before: { state: 'pending' },
          after: { accountId: VIEWER },
          actor: 'authenticated',
        }),
      ]);
      expect(serializable()).toBe(true);
    });

    it("refuses one's own factor, a holder of more keys, and an account without a factor", async () => {
      const { resetFactor } = setUp();
      for (const [account, n] of [
        [ROOT, 2],
        [ROOT2, 3],
      ] as const) {
        seedFactor(account, n);
      }

      await expect(resetFactor.execute(as(ROOT), { accountId: ROOT })).resolves.toEqual({
        ok: false,
        error: { code: 'member.self' },
      });
      await expect(resetFactor.execute(as(LEAD), { accountId: ROOT2 })).resolves.toEqual({
        ok: false,
        error: { code: 'member.outranks-actor' },
      });
      await expect(resetFactor.execute(as(ROOT), { accountId: SUPPORT })).resolves.toEqual({
        ok: false,
        error: { code: 'second-factor.none' },
      });
      await expect(resetFactor.execute(as(ROOT), { accountId: COURIER })).resolves.toEqual({
        ok: false,
        error: { code: 'account.unknown' },
      });
      expect(fakes.factors.has(ROOT2)).toBe(true);
    });
  });

  describe('admin invitations with an inviter (8b)', () => {
    it('issues an invitation that names its inviter, without a token, audited as the actor', async () => {
      const { invite } = setUp();

      const result = await invite.execute(as(ROOT), {
        origin: ORIGIN,
        email: 'New.Admin@Example.com',
        roleId: roleOf('viewer'),
      });

      expect(result).toMatchObject({
        ok: true,
        value: { code: 'invitation.issued', replaced: false },
      });
      if (!result.ok) throw new Error('refused');
      expect(fakes.invitations.get(result.value.invitationId)).toMatchObject({
        kind: 'admin',
        roleId: roleOf('viewer'),
        invitedByAccountId: ROOT,
        tokenHash: null,
        state: 'pending',
      });
      expect(eventTypes()).toEqual(['identity.invitation-issued.v1']);
      expect(fakes.audits).toEqual([
        expect.objectContaining({
          action: 'identity.invitation.issued',
          after: { kind: 'admin', roleId: roleOf('viewer') },
          actor: 'authenticated',
        }),
      ]);
      expect(JSON.stringify(fakes.audits)).not.toContain('example.com');
    });

    it('refuses a role the actor cannot grant, and answers unknown for one out of reach', async () => {
      const { invite } = setUp();

      for (const roleId of [LEAD_ROLE, roleOf('platform-administrator')]) {
        await expect(
          invite.execute(as(LEAD), { origin: ORIGIN, email: 'x@example.com', roleId }),
        ).resolves.toEqual({ ok: false, error: { code: 'role.not-grantable' } });
      }
      for (const roleId of [roles.get('merchant:merchant')!.id, UNKNOWN_ROLE]) {
        await expect(
          invite.execute(as(ROOT), { origin: ORIGIN, email: 'x@example.com', roleId }),
        ).resolves.toEqual({ ok: false, error: { code: 'role.unknown' } });
      }
      // The system role, by a holder of it (R3).
      await expect(
        invite.execute(as(ROOT), {
          origin: ORIGIN,
          email: 'x@example.com',
          roleId: roleOf('platform-administrator'),
        }),
      ).resolves.toMatchObject({ ok: true });
    });

    it('refuses an invitation to Operator from an admin without identity.merchant.view (I-1a)', async () => {
      const { invite } = setUp();

      await expect(
        invite.execute(as(LEAD), {
          origin: ORIGIN,
          email: 'moderator@example.com',
          roleId: roleOf('operator'),
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'role.not-grantable' } });
      expect(fakes.invitations.size).toBe(0);
      expect(fakes.audits).toEqual([]);
      // A holder of the key (the system role) may invite to it.
      await expect(
        invite.execute(as(ROOT), {
          origin: ORIGIN,
          email: 'moderator@example.com',
          roleId: roleOf('operator'),
        }),
      ).resolves.toMatchObject({ ok: true });
    });

    it('refuses an address of an existing admin, a second pending invitation and a malformed address', async () => {
      const { invite } = setUp();

      await expect(
        invite.execute(as(ROOT), {
          origin: ORIGIN,
          email: 'A4@example.com',
          roleId: roleOf('viewer'),
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'account.exists' } });
      await invite.execute(as(ROOT), {
        origin: ORIGIN,
        email: 'y@example.com',
        roleId: roleOf('viewer'),
      });
      await expect(
        invite.execute(as(ROOT), {
          origin: ORIGIN,
          email: 'Y@example.com',
          roleId: roleOf('viewer'),
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'invitation.already-pending' } });
      await expect(
        invite.execute(as(ROOT), {
          origin: ORIGIN,
          email: 'not-an-address',
          roleId: roleOf('viewer'),
        }),
      ).resolves.toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'email', code: 'format' }] },
      });
    });

    it('replaces a stale pending invitation, revoking it with its event and audit row (M7)', async () => {
      const { invite } = setUp();
      const stale = seedInvitation(1, { expiresAt: START.subtract({ minutes: 1 }) });

      const result = await invite.execute(as(ROOT), {
        origin: ORIGIN,
        email: 'invitee1@example.com',
        roleId: roleOf('viewer'),
      });

      expect(result).toMatchObject({ ok: true, value: { replaced: true } });
      expect(fakes.invitations.get(stale)).toMatchObject({ state: 'revoked', email: null });
      expect(eventTypes()).toEqual([
        'identity.invitation-revoked.v1',
        'identity.invitation-issued.v1',
      ]);
      expect(fakes.audits.map((a) => a.action)).toEqual([
        'identity.invitation.revoked',
        'identity.invitation.issued',
      ]);
    });

    it('sends a pending invitation again: the old token stops working (E2)', async () => {
      const { resend } = setUp();
      const invitationId = seedInvitation(2);

      await expect(resend.execute(as(ROOT), { invitationId, origin: ORIGIN })).resolves.toEqual({
        ok: true,
        value: { code: 'invitation.reissued', invitationId },
      });
      expect(fakes.invitations.get(invitationId)).toMatchObject({
        tokenHash: null,
        expiresAt: null,
        state: 'pending',
        version: 3,
      });
      expect(eventTypes()).toEqual(['identity.invitation-issued.v1']);
      expect(fakes.audits.map((a) => a.action)).toEqual(['identity.invitation.reissued']);
    });

    it('counts each re-send on the address, then answers request.throttled and changes nothing', async () => {
      const { resend } = setUp();
      const invitationId = seedInvitation(2);
      const limit = new MarketConfigIdentityPolicy(markets).mailThrottles(market).account.limit;
      for (let n = 0; n < limit; n += 1) {
        await expect(
          resend.execute(as(ROOT), { invitationId, origin: ORIGIN }),
        ).resolves.toMatchObject({ ok: true, value: { code: 'invitation.reissued' } });
      }
      const before = { ...fakes.invitations.get(invitationId)! };
      const audits = fakes.audits.length;

      await expect(resend.execute(as(ROOT), { invitationId, origin: ORIGIN })).resolves.toEqual({
        ok: false,
        error: { code: 'request.throttled', retryAfterSeconds: expect.any(Number) as number },
      });
      expect(fakes.invitations.get(invitationId)).toEqual(before);
      expect(fakes.audits).toHaveLength(audits);
      // The address is counted in the admin population, never the courier one.
      expect([...fakes.throttles.values()].map((row) => row.kind).sort()).toEqual([
        'mail.account',
        'mail.origin',
      ]);
    });

    it('refuses a re-send of a decided, a first-admin or an ungrantable invitation', async () => {
      const { resend } = setUp();
      const revoked = seedInvitation(3, { state: 'revoked', email: null, decidedAt: START });
      const firstAdmin = seedInvitation(4, { invitedByAccountId: null });
      const protectedRole = seedInvitation(5, { roleId: LEAD_ROLE });

      await expect(
        resend.execute(as(ROOT), { invitationId: revoked, origin: ORIGIN }),
      ).resolves.toEqual({
        ok: false,
        error: { code: 'invitation.rejected' },
      });
      // Mohammad Q4: found (revoke finds it), never sent again.
      await expect(
        resend.execute(as(ROOT), { invitationId: firstAdmin, origin: ORIGIN }),
      ).resolves.toEqual({
        ok: false,
        error: { code: 'invitation.rejected' },
      });
      await expect(
        resend.execute(as(LEAD), { invitationId: protectedRole, origin: ORIGIN }),
      ).resolves.toEqual({
        ok: false,
        error: { code: 'role.not-grantable' },
      });
      expect(fakes.events).toEqual([]);
    });

    it('revokes a pending invitation once; an unknown id is unknown', async () => {
      const { revoke } = setUp();
      const invitationId = seedInvitation(6);

      await expect(revoke.execute(as(ROOT), { invitationId })).resolves.toEqual({
        ok: true,
        value: { code: 'invitation.revoked', invitationId },
      });
      expect(fakes.invitations.get(invitationId)).toMatchObject({ state: 'revoked', email: null });
      await expect(revoke.execute(as(ROOT), { invitationId })).resolves.toEqual({
        ok: false,
        error: { code: 'invitation.rejected' },
      });
      await expect(
        revoke.execute(as(ROOT), {
          invitationId: id<'Invitation'>('01990000-0000-7000-8000-00000000ffff'),
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'invitation.unknown' } });
      expect(eventTypes()).toEqual(['identity.invitation-revoked.v1']);
      expect(fakes.audits.map((a) => a.action)).toEqual(['identity.invitation.revoked']);
    });

    it('denies the invitation routes to an admin without identity.admin-account.invite', async () => {
      const { invite, resend, revoke } = setUp();
      const invitationId = seedInvitation(7);

      await expect(
        invite.execute(as(SUPPORT), {
          origin: ORIGIN,
          email: 'z@example.com',
          roleId: roleOf('viewer'),
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'access.denied' } });
      await expect(resend.execute(as(SUPPORT), { invitationId, origin: ORIGIN })).resolves.toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      await expect(revoke.execute(as(SUPPORT), { invitationId })).resolves.toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
    });
  });

  /** A change committed by someone else: the account disabled (its version steps). */
  function disabled(account: Id<'Account'>) {
    const state = fakes.accounts.get(account)!;
    fakes.accounts.set(account, { ...state, status: 'disabled', version: state.version + 1 });
  }

  /** A change committed by someone else: the account's role replaced. */
  function demoted(account: Id<'Account'>, roleId: Id<'Role'>) {
    const state = [...fakes.assignments.values()].find((a) => a.accountId === account)!;
    fakes.assignments.set(state.id, { ...state, roleId, version: state.version + 1 });
  }

  function seedAdmin(n: number, idOf: Id<'Account'>, roleId: Id<'Role'>) {
    fakes.seedAccount({
      id: idOf,
      marketId,
      population: 'admin',
      email: { typed: `a${n}@example.com`, normalized: `a${n}@example.com` },
      displayName: `Account ${n}`,
      status: 'active',
      emailVerifiedAt: START,
      signedUpAt: START,
      createdAt: START,
      version: 1,
      credential: { passwordHash: fakeHashOf('x'), changedAt: START },
    });
    fakes.seedAssignment({
      id: id<'RoleAssignment'>(`01990000-0000-7000-8000-${n12(0xe100 + n)}`),
      marketId,
      accountId: idOf,
      roleId,
      assignedByAccountId: null,
      assignedAt: START,
      version: 1,
    });
  }

  type Built = ReturnType<typeof setUp>;
  /** Every writing use case of the slices, by ROOT, on a target prepared for it. */
  const WRITERS: readonly [string, (built: Built) => Promise<Result<unknown, unknown>>][] = [
    [
      'assign',
      (b) => b.assign.execute(as(ROOT), { accountId: VIEWER, roleId: roleOf('dispatcher') }),
    ],
    ['disable admin', (b) => b.disableAdmin.execute(as(ROOT), { accountId: VIEWER })],
    [
      'enable admin',
      (b) => {
        disabled(VIEWER);
        return b.enableAdmin.execute(as(ROOT), { accountId: VIEWER });
      },
    ],
    ['disable courier', (b) => b.disableCourier.execute(as(ROOT), { accountId: COURIER })],
    [
      'enable courier',
      (b) => {
        disabled(COURIER);
        return b.enableCourier.execute(as(ROOT), { accountId: COURIER });
      },
    ],
    [
      'reset factor',
      (b) => {
        seedFactor(VIEWER, 9, 'active');
        return b.resetFactor.execute(as(ROOT), { accountId: VIEWER });
      },
    ],
    [
      'invite',
      (b) =>
        b.invite.execute(as(ROOT), {
          origin: ORIGIN,
          email: 'c1@example.com',
          roleId: roleOf('viewer'),
        }),
    ],
    [
      'resend',
      (b) => b.resend.execute(as(ROOT), { invitationId: seedInvitation(20), origin: ORIGIN }),
    ],
    ['revoke', (b) => b.revoke.execute(as(ROOT), { invitationId: seedInvitation(21) })],
  ];

  describe('the actor re-checked in the writing unit (Mohammad C1, Hassan I1)', () => {
    it.each(WRITERS)(
      '%s: each succeeds for an actor the gate and the unit both allow',
      async (_, run) => {
        const built = setUp();

        await expect(run(built)).resolves.toMatchObject({ ok: true });
      },
    );

    it.each(WRITERS)(
      '%s: refused when the actor is disabled between the gate and the unit',
      async (_, run) => {
        const built = setUp();
        betweenGateAndUnit = () => disabled(ROOT);

        await expect(run(built)).resolves.toEqual({ ok: false, error: { code: 'access.denied' } });
        expect(fakes.events).toEqual([]);
        expect(fakes.audits).toEqual([]);
      },
    );

    it.each(WRITERS)(
      '%s: refused when the actor is demoted between the gate and the unit',
      async (_, run) => {
        const built = setUp();
        betweenGateAndUnit = () => demoted(ROOT, roleOf('viewer'));

        await expect(run(built)).resolves.toEqual({ ok: false, error: { code: 'access.denied' } });
        expect(fakes.events).toEqual([]);
        expect(fakes.audits).toEqual([]);
      },
    );

    it('refuses an actor whose email is no longer verified in the unit', async () => {
      const { assign } = setUp();
      betweenGateAndUnit = () => {
        const state = fakes.accounts.get(ROOT)!;
        fakes.accounts.set(ROOT, { ...state, emailVerifiedAt: null });
      };

      await expect(
        assign.execute(as(ROOT), { accountId: VIEWER, roleId: roleOf('dispatcher') }),
      ).resolves.toEqual({ ok: false, error: { code: 'access.denied' } });
    });

    it('three administrators: B disables A while A demotes C; A is refused, C keeps the role', async () => {
      const { assign, disableAdmin } = setUp();
      const third = accountId(8);
      seedAdmin(8, third, roleOf('platform-administrator'));
      // B's disable of A commits after A's request passed the gate.
      betweenGateAndUnit = () => disableAdmin.execute(as(ROOT2), { accountId: ROOT });

      const demotion = await assign.execute(as(ROOT), {
        accountId: third,
        roleId: roleOf('viewer'),
      });

      expect(demotion).toEqual({ ok: false, error: { code: 'access.denied' } });
      expect(statusOf(ROOT)).toBe('disabled');
      expect(roleIdOf(third)).toBe(roleOf('platform-administrator'));
      expect(eventTypes()).toEqual(['identity.account-disabled.v1']);
    });
  });

  describe('enable, courier and reset edges (Sajad 6 to 8)', () => {
    it('enable refuses oneself, a holder of more keys, a merchant account and an actor without the key', async () => {
      const { enableAdmin, enableCourier } = setUp();
      disabled(ROOT2);
      disabled(COURIER);

      await expect(enableAdmin.execute(as(ROOT), { accountId: ROOT })).resolves.toEqual({
        ok: false,
        error: { code: 'member.self' },
      });
      await expect(enableAdmin.execute(as(LEAD), { accountId: ROOT2 })).resolves.toEqual({
        ok: false,
        error: { code: 'member.outranks-actor' },
      });
      await expect(enableAdmin.execute(as(ROOT), { accountId: MERCHANT_ACCOUNT })).resolves.toEqual(
        {
          ok: false,
          error: { code: 'account.unknown' },
        },
      );
      await expect(enableAdmin.execute(as(SUPPORT), { accountId: ROOT2 })).resolves.toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      await expect(enableCourier.execute(as(VIEWER), { accountId: COURIER })).resolves.toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(statusOf(ROOT2)).toBe('disabled');
      expect(statusOf(COURIER)).toBe('disabled');
    });

    it('disables a courier: every courier session revoked, its challenges void; twice is refused', async () => {
      const { disableCourier } = setUp();
      seedSession(COURIER, 6);
      seedSession(COURIER, 7);
      seedChallenge(COURIER, 6);
      seedSession(VIEWER, 8);

      await expect(disableCourier.execute(as(SUPPORT), { accountId: COURIER })).resolves.toEqual({
        ok: true,
        value: { code: 'account.disabled', accountId: COURIER, revokedSessions: 2 },
      });
      const sessions = [...fakes.sessions.values()].map((s) => s.session);
      expect(sessions.filter((s) => s.accountId === COURIER).map((s) => s.revokedReason)).toEqual([
        'account-disabled',
        'account-disabled',
      ]);
      expect(sessions.find((s) => s.accountId === VIEWER)!.revokedAt).toBeNull();
      expect([...fakes.challenges.values()]).toEqual([]);
      expect(fakes.audits).toEqual([
        expect.objectContaining({
          action: 'identity.account.disabled',
          after: { status: 'disabled', population: 'courier' },
        }),
      ]);
      await expect(disableCourier.execute(as(SUPPORT), { accountId: COURIER })).resolves.toEqual({
        ok: false,
        error: { code: 'account.already-disabled' },
      });
    });

    it.each(['active', 'locked'] as const)(
      'resets an %s factor of another admin, with its ten recovery codes',
      async (kind) => {
        const { resetFactor } = setUp();
        seedFactor(VIEWER, 10, kind);

        await expect(resetFactor.execute(as(ROOT), { accountId: VIEWER })).resolves.toMatchObject({
          ok: true,
          value: { code: 'second-factor.reset' },
        });
        expect(fakes.factors.has(VIEWER)).toBe(false);
        expect(fakes.audits).toEqual([
          expect.objectContaining({
            action: 'identity.second-factor.reset',
            before: { state: 'active' },
          }),
        ]);
      },
    );

    it('reset refuses an actor without the key and answers a merchant account as unknown', async () => {
      const { resetFactor } = setUp();
      seedFactor(SUPPORT, 11, 'active');

      await expect(resetFactor.execute(as(VIEWER), { accountId: SUPPORT })).resolves.toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      await expect(resetFactor.execute(as(ROOT), { accountId: MERCHANT_ACCOUNT })).resolves.toEqual(
        {
          ok: false,
          error: { code: 'account.unknown' },
        },
      );
      expect(fakes.factors.has(SUPPORT)).toBe(true);
    });
  });

  describe('re-send and invite edges (Mohammad C2, Q4; Hassan L3; Sajad 4, 9)', () => {
    const LIFETIME_MINUTES = () =>
      markets.get(market.marketId).identity.invitations!.lifetimeMinutes.admin!;

    it('re-sends up to createdAt plus the lifetime, and refuses at it (C2)', async () => {
      const { resend } = setUp();
      const early = seedInvitation(30);
      const late = seedInvitation(31);
      const lifetime = LIFETIME_MINUTES();

      clock.set(START.add({ minutes: lifetime - 1 }));
      await expect(
        resend.execute(as(ROOT), { invitationId: early, origin: ORIGIN }),
      ).resolves.toMatchObject({
        ok: true,
      });
      clock.set(START.add({ minutes: lifetime }));
      await expect(
        resend.execute(as(ROOT), { invitationId: late, origin: ORIGIN }),
      ).resolves.toEqual({
        ok: false,
        error: { code: 'invitation.rejected' },
      });
      expect(fakes.invitations.get(late)!.tokenHash).not.toBeNull();
    });

    it('refuses a re-send whose original inviter could no longer issue it (L3)', async () => {
      const { resend } = setUp();
      const byDisabled = seedInvitation(32, { invitedByAccountId: ROOT2 });
      const byDemoted = seedInvitation(33, { invitedByAccountId: LEAD });
      const byCourier = seedInvitation(34, { invitedByAccountId: COURIER });
      const byUnknown = seedInvitation(35, { invitedByAccountId: UNKNOWN });
      disabled(ROOT2);
      demoted(LEAD, roleOf('viewer'));

      for (const invitationId of [byDisabled, byDemoted, byCourier, byUnknown]) {
        await expect(resend.execute(as(ROOT), { invitationId, origin: ORIGIN })).resolves.toEqual({
          ok: false,
          error: { code: 'invitation.rejected' },
        });
      }
      expect(fakes.events).toEqual([]);
    });

    it("refuses a re-send whose role is gone or not an admin's (R12)", async () => {
      const { resend } = setUp();
      const gone = seedInvitation(36, { roleId: UNKNOWN_ROLE });
      const merchantRole = seedInvitation(37, { roleId: roles.get('merchant:merchant')!.id });

      for (const invitationId of [gone, merchantRole]) {
        await expect(resend.execute(as(ROOT), { invitationId, origin: ORIGIN })).resolves.toEqual({
          ok: false,
          error: { code: 'invitation.rejected' },
        });
      }
    });

    it('answers access.unavailable for invite and resend in a Market without an admin invitation lifetime', async () => {
      const { invite, resend } = setUp({ withoutInvitationLifetime: true });
      const invitationId = seedInvitation(38);

      await expect(
        invite.execute(as(ROOT), {
          origin: ORIGIN,
          email: 'x@example.com',
          roleId: roleOf('viewer'),
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'access.unavailable' } });
      await expect(resend.execute(as(ROOT), { invitationId, origin: ORIGIN })).resolves.toEqual({
        ok: false,
        error: { code: 'access.unavailable' },
      });
      expect(fakes.invitations.size).toBe(1);
    });
  });

  describe("inviterMayStillGrant, the acceptance's re-check of the inviter (Hassan 14.2, L2)", () => {
    it('stands for an active admin who holds the invite key and can grant the role', async () => {
      const { inviter } = setUp();

      for (const [account, role] of [
        [ROOT, roleOf('platform-administrator')],
        [ROOT, roleOf('viewer')],
        [LEAD, roleOf('viewer')],
      ] as const) {
        const found = await fakes.roleRepository.findById(market, role);
        await expect(inviterMayStillGrant(inviter, market, account, found!)).resolves.toEqual({
          ok: true,
          value: undefined,
        });
      }
    });

    it('refuses a missing, non-admin, disabled or unverified inviter', async () => {
      const { inviter } = setUp();
      const viewer = (await fakes.roleRepository.findById(market, roleOf('viewer')))!;
      disabled(ROOT2);
      const state = fakes.accounts.get(LEAD)!;
      fakes.accounts.set(LEAD, { ...state, emailVerifiedAt: null });

      for (const account of [UNKNOWN, COURIER, MERCHANT_ACCOUNT, ROOT2, LEAD]) {
        await expect(inviterMayStillGrant(inviter, market, account, viewer)).resolves.toEqual({
          ok: false,
          error: 'inviter-inactive',
        });
      }
    });

    it('refuses an inviter that lost the invite key, or can no longer grant the role', async () => {
      const { inviter } = setUp();
      const viewer = (await fakes.roleRepository.findById(market, roleOf('viewer')))!;
      const administrator = (await fakes.roleRepository.findById(
        market,
        roleOf('platform-administrator'),
      ))!;

      // SUPPORT never held identity.admin-account.invite; ROOT2 is demoted to viewer.
      demoted(ROOT2, roleOf('viewer'));
      for (const account of [SUPPORT, ROOT2]) {
        await expect(inviterMayStillGrant(inviter, market, account, viewer)).resolves.toEqual({
          ok: false,
          error: 'inviter-inactive',
        });
      }
      // LEAD holds the key but not the Platform Administrator role (R3), nor its own role's
      // protected keys without it (R11).
      for (const role of [
        administrator,
        (await fakes.roleRepository.findById(market, LEAD_ROLE))!,
      ]) {
        await expect(inviterMayStillGrant(inviter, market, LEAD, role)).resolves.toEqual({
          ok: false,
          error: 'inviter-cannot-grant',
        });
      }
    });

    it('reads the inviter in the context Market only', async () => {
      const { inviter } = setUp();
      const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', PLATFORM_TENANT_ID);
      const viewer = (await fakes.roleRepository.findById(market, roleOf('viewer')))!;

      await expect(inviterMayStillGrant(inviter, other, ROOT, viewer)).resolves.toEqual({
        ok: false,
        error: 'inviter-inactive',
      });
    });
  });

  /** setUp, with the HF8 count answering `holders` (a concurrent change already committed). */
  function setUpWithHolders(holders: Id<'Account'>[]) {
    const built = setUp();
    fakes.assignmentRepository.activeHoldersOf = () => Promise.resolve(holders);
    return built;
  }
});
