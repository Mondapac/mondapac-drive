import { parseId, Temporal } from '@mondapac-drive/shared-kernel';
import type { Id, MarketContext, Result } from '@mondapac-drive/shared-kernel';
import {
  FixedClock,
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
import { CheckedInRoleSeed } from '../../infrastructure/seed/checked-in-role-seed';
import { MarketConfigIdentityPolicy } from '../../infrastructure/market-config-identity-policy';
import { AccountAuthorisationCheck } from '../access/account-authorisation-check';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { ThrottleKeys } from '../ports/session-secrets';
import { AssignAdminRole } from './assign-admin-role.use-case';
import { DisableAdminAccount } from './disable-admin-account.use-case';
import { EnableAdminAccount } from './enable-admin-account.use-case';
import {
  ListAdminTeam,
  type ActionHint,
  type AdminTeamAccountRow,
  type AdminTeamInvitationRow,
  type AdminTeamPage,
} from './list-admin-team.use-case';
import { ResendAdminInvitation } from './resend-admin-invitation.use-case';
import { ResetOtherAdminSecondFactor } from './reset-other-admin-second-factor.use-case';
import { RevokeAdminInvitation } from './revoke-admin-invitation.use-case';

// Identity slice 8c (identity design 5.3 `identity.admin-account.view`, 8.6 rows 2 and 6; Ali's
// ruling 2026-10-08): the admin team list with per-row action hints. The real gate, registry and
// checked-in seed; identity's stores as fakes. Both Market fixtures. The central test runs every
// command for every row and actor and asserts that the hint is the command's answer: the hints
// come from the commands' own verdicts, never a second implementation.

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
const TOKEN_HASH = new Uint8Array(32).fill(7);

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

const ROOT = accountId(1);
const ROOT2 = accountId(2);
const LEAD = accountId(3);
const VIEWER = accountId(4);
const SUPPORT = accountId(5);
const COURIER = accountId(6);
const MERCHANT_ACCOUNT = accountId(7);
const OFF = accountId(8);
const PARTIAL = accountId(9);
const PARTIAL_ROLE = id<'Role'>('01990000-0000-7000-8000-00000000c0dd');

/** A platform custom role with protected keys but not the system role (as in 8a-2's spec). */
const LEAD_KEYS = [
  'delivery.delivery.cancel',
  'delivery.delivery.dispatch',
  'delivery.delivery.view',
  'identity.admin-account.disable',
  'identity.admin-account.invite',
  'identity.admin-account.reset-second-factor',
  'identity.admin-account.view',
  'identity.courier-account.disable',
  'identity.courier-account.invite',
  'identity.courier-account.view',
  'identity.platform-role.assign',
  'identity.platform-role.view',
];
/** The keys of the custom viewer role: it holds less than every other admin role. */
const VIEWER_KEYS = ['identity.admin-account.view', 'identity.platform-role.view'];

type AccountAction = keyof AdminTeamAccountRow['actions'];
type InvitationAction = keyof AdminTeamInvitationRow['actions'];

describe.each(TEST_MARKETS)('ListAdminTeam in market %s (slice 8c)', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const marketId = code as AccountState['marketId'];
  let fakes: IdentityFakes;
  let units: (UnitOfWorkOptions | undefined)[];
  let roles: Map<string, RoleState>;
  let clock: FixedClock;
  let factorReads: number;

  const roleOf = (seedCode: string) => roles.get(`platform:${seedCode}`)!.id;

  function setUp(options: { readonly withoutInvitationLifetime?: boolean } = {}) {
    fakes = new IdentityFakes();
    units = [];
    factorReads = 0;
    clock = new FixedClock(START);
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
    admin(2, ROOT2, roleOf('platform-administrator'));
    admin(3, LEAD, LEAD_ROLE);
    admin(4, VIEWER, roleOf('viewer'));
    admin(5, SUPPORT, roleOf('dispatcher'));
    account(6, COURIER, 'courier');
    account(7, MERCHANT_ACCOUNT, 'merchant');
    admin(8, OFF, roleOf('operator'), 'disabled');

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
    const permissions = realPermissionRegistry();
    const base = new MarketConfigIdentityPolicy(markets);
    const policy: IdentityMarketPolicy =
      options.withoutInvitationLifetime === true
        ? Object.assign(Object.create(base) as IdentityMarketPolicy, {
            invitationLifetimeMinutes: () => null,
          })
        : base;
    const factors = {
      ...fakes.factorRepository,
      presentAmong: (m: MarketContext, ids: readonly Id<'Account'>[]) => {
        factorReads += 1;
        return fakes.factorRepository.presentAmong(m, ids);
      },
    };
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
    const invitations = fakes.invitationRepository;
    return {
      list: new ListAdminTeam(gate, {
        unitOfWork,
        accounts: fakes.accountRepository,
        adminAccounts: fakes.adminAccountReader,
        invitations,
        roles: fakes.roleRepository,
        assignments: fakes.assignmentRepository,
        grants: fakes.grantReader,
        effectiveKeys,
        permissions,
        factors,
        policy,
        clock,
      }),
      commands: {
        changeRole: new AssignAdminRole(gate, { ...common, permissions }),
        disable: new DisableAdminAccount(gate, status),
        enable: new EnableAdminAccount(gate, status),
        resetSecondFactor: new ResetOtherAdminSecondFactor(gate, {
          ...status,
          factors: fakes.factorRepository,
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
      },
    };
  }

  const as = (account: Id<'Account'>) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: account,
        sessionId: SESSION_ID,
        merchantId: null,
      }),
      'admin-team-list-0001',
    );

  function seedFactor(account: Id<'Account'>, n: number) {
    fakes.factors.set(account, {
      id: id<'SecondFactor'>(`01990000-0000-7000-8000-${n12(0xf300 + n)}`),
      marketId,
      accountId: account,
      state: 'active',
      secretCiphertext: 'sealed-secret',
      pendingSecretCiphertext: null,
      lastAcceptedStep: 1,
      activatedAt: START,
      lockedAt: null,
      createdAt: START,
      recoveryCodes: Array.from({ length: 10 }, (_, i) => ({
        position: i + 1,
        codeHash: new Uint8Array(32).fill(i + 1),
        usedAt: null,
      })),
      version: 1,
    });
  }

  function seedInvitation(
    n: number,
    overrides: Partial<InvitationState> = {},
    prefix = 0xf400,
  ): Id<'Invitation'> {
    const invitationId = id<'Invitation'>(`01990000-0000-7000-8000-${n12(prefix + n)}`);
    const email = parseEmailAddress(`Invitee${n}@Example.com`);
    if (!email.ok) throw new Error('bad email');
    fakes.invitations.set(invitationId, {
      id: invitationId,
      marketId,
      kind: 'admin',
      email: email.value,
      roleId: roleOf('viewer'),
      invitedByAccountId: ROOT,
      tokenHash: TOKEN_HASH,
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

  /** The invitations every scenario holds: one of each kind of resend answer. */
  function seedInvitations() {
    return {
      plain: seedInvitation(1),
      firstAdmin: seedInvitation(2, { invitedByAccountId: null }),
      systemRole: seedInvitation(3, { roleId: roleOf('platform-administrator') }),
      byDisabled: seedInvitation(4, { invitedByAccountId: OFF }),
      undispatched: seedInvitation(5, { tokenHash: null, expiresAt: null, version: 1 }),
      expired: seedInvitation(6, { expiresAt: START.subtract({ minutes: 1 }) }),
      roleGone: seedInvitation(7, {
        roleId: id<'Role'>('01990000-0000-7000-8000-00000000c0cc'),
      }),
      // Not listed: decided, another scope, another Market.
      revoked: seedInvitation(8, { state: 'revoked', email: null, decidedAt: START }),
    };
  }

  async function page(
    list: ListAdminTeam,
    actor: Id<'Account'>,
    input: { after?: string | null; limit: number } = { limit: 100 },
  ): Promise<AdminTeamPage> {
    const result = await list.execute(as(actor), input);
    if (!result.ok) throw new Error(`listed: ${result.error.code}`);
    return result.value;
  }
  const accountRow = (p: AdminTeamPage, account: Id<'Account'>) =>
    p.items.find((row) => row.type === 'account' && row.accountId === account) as
      AdminTeamAccountRow | undefined;
  const invitationRow = (p: AdminTeamPage, invitation: Id<'Invitation'>) =>
    p.items.find((row) => row.type === 'invitation' && row.invitationId === invitation) as
      AdminTeamInvitationRow | undefined;
  const no = (code: string): ActionHint => ({ allowed: false, code });
  const yes: ActionHint = { allowed: true, code: null };

  it('lists the admin accounts with their roles and the pending admin invitations, by id', async () => {
    const { list } = setUp();
    const seeded = seedInvitations();

    const listed = await page(list, ROOT);

    const ids = listed.items.map((row) =>
      row.type === 'account' ? row.accountId : row.invitationId,
    );
    expect(ids).toEqual([
      ROOT,
      ROOT2,
      LEAD,
      VIEWER,
      SUPPORT,
      OFF,
      seeded.plain,
      seeded.firstAdmin,
      seeded.systemRole,
      seeded.byDisabled,
      seeded.undispatched,
      seeded.expired,
      seeded.roleGone,
    ]);
    expect(listed.next).toBeNull();
    expect(accountRow(listed, ROOT)).toMatchObject({
      email: 'A1@Example.com',
      displayName: 'Account 1',
      status: 'active',
      self: true,
      role: { roleId: roleOf('platform-administrator'), kind: 'system' },
    });
    expect(accountRow(listed, LEAD)).toMatchObject({
      self: false,
      role: { roleId: LEAD_ROLE, kind: 'custom', seedCode: null },
    });
    expect(accountRow(listed, OFF)).toMatchObject({ status: 'disabled' });
    expect(invitationRow(listed, seeded.plain)).toMatchObject({
      email: 'Invitee1@Example.com',
      role: { roleId: roleOf('viewer'), kind: 'custom', seedCode: null },
      invitedByAccountId: ROOT,
      status: 'pending',
      createdAt: START,
      expiresAt: START.add({ hours: 1 }),
    });
    expect(invitationRow(listed, seeded.expired)).toMatchObject({ status: 'expired' });
    expect(invitationRow(listed, seeded.undispatched)).toMatchObject({ expiresAt: null });
    expect(invitationRow(listed, seeded.roleGone)).toMatchObject({ role: null });
    // One read-only unit for the gate and one for the list (ADR-0025): no transaction opened.
    expect(units).toEqual([{ readOnly: true }, { readOnly: true }]);
  });

  it('never answers a token, its hash, a credential or a factor secret (Hassan, 8c)', async () => {
    const { list } = setUp();
    seedInvitations();
    seedFactor(ROOT2, 2);

    const text = JSON.stringify(await page(list, ROOT));

    for (const forbidden of ['tokenHash', 'token', 'passwordHash', 'secret', 'recovery', 'hash']) {
      expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    expect(text).not.toContain('sealed-secret');
  });

  it('gives a Platform Administrator the hints its commands would answer', async () => {
    const { list } = setUp();
    const seeded = seedInvitations();
    seedFactor(ROOT2, 2);

    const listed = await page(list, ROOT);

    expect(accountRow(listed, ROOT)!.actions).toEqual({
      changeRole: no('member.self'),
      disable: no('member.self'),
      enable: no('member.self'),
      resetSecondFactor: no('member.self'),
    });
    expect(accountRow(listed, ROOT2)!.actions).toEqual({
      changeRole: yes,
      disable: yes,
      enable: no('account.already-active'),
      resetSecondFactor: yes,
    });
    expect(accountRow(listed, VIEWER)!.actions.resetSecondFactor).toEqual(no('second-factor.none'));
    expect(accountRow(listed, OFF)!.actions).toMatchObject({
      disable: no('account.already-disabled'),
      enable: yes,
    });
    expect(invitationRow(listed, seeded.plain)!.actions).toEqual({ resend: yes, revoke: yes });
    expect(invitationRow(listed, seeded.firstAdmin)!.actions).toEqual({
      resend: no('invitation.rejected'),
      revoke: yes,
    });
    expect(invitationRow(listed, seeded.byDisabled)!.actions.resend).toEqual(
      no('invitation.rejected'),
    );
    expect(invitationRow(listed, seeded.roleGone)!.actions.resend).toEqual(
      no('invitation.rejected'),
    );
    expect(invitationRow(listed, seeded.expired)!.actions.resend).toEqual(yes);
  });

  it('gives an admin without the system role R1 and R3 answers (LEAD)', async () => {
    const { list } = setUp();
    const seeded = seedInvitations();

    const listed = await page(list, LEAD);

    for (const holder of [ROOT, ROOT2]) {
      expect(accountRow(listed, holder)!.actions).toEqual({
        changeRole: no('member.outranks-actor'),
        disable: no('member.outranks-actor'),
        enable: no('member.outranks-actor'),
        resetSecondFactor: no('member.outranks-actor'),
      });
    }
    expect(accountRow(listed, VIEWER)!.actions).toMatchObject({ changeRole: yes, disable: yes });
    expect(invitationRow(listed, seeded.systemRole)!.actions.resend).toEqual(
      no('role.not-grantable'),
    );
  });

  it('answers access.denied for every action whose key the actor lacks, reading nothing for it', async () => {
    const { list } = setUp();
    const seeded = seedInvitations();
    seedFactor(ROOT2, 2);

    const listed = await page(list, VIEWER);

    for (const row of listed.items) {
      const hints = Object.values<ActionHint>(row.actions);
      expect(hints.every((hint) => hint.code === 'access.denied' && !hint.allowed)).toBe(true);
    }
    expect(invitationRow(listed, seeded.plain)).toBeDefined();
    // Without the reset key the factors are never read: no hint can tell who has one.
    expect(factorReads).toBe(0);
  });

  it('refuses an admin without identity.admin-account.view, and any other population', async () => {
    const { list } = setUp();

    expect(await list.execute(as(SUPPORT), { limit: 10 })).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    const courier = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'courier',
        accountId: COURIER,
        sessionId: SESSION_ID,
        merchantId: null,
      }),
      'admin-team-list-0002',
    );
    expect(await list.execute(courier, { limit: 10 })).toMatchObject({ ok: false });
  });

  it('answers member.last-holder from LastHolderPolicy over the holders it reads once', async () => {
    const { list } = setUp();
    let reads = 0;
    // As a concurrent change could leave it: ROOT2 is the only holder who can sign in.
    fakes.assignmentRepository.activeHoldersOf = () => {
      reads += 1;
      return Promise.resolve([ROOT2]);
    };

    const listed = await page(list, ROOT);

    expect(accountRow(listed, ROOT2)!.actions).toEqual({
      changeRole: no('member.last-holder'),
      disable: no('member.last-holder'),
      enable: no('account.already-active'),
      resetSecondFactor: no('second-factor.none'),
    });
    expect(reads).toBe(1);
  });

  it('answers access.unavailable for a re-send when the Market has no admin invitation lifetime', async () => {
    const { list } = setUp({ withoutInvitationLifetime: true });
    const seeded = seedInvitations();

    const listed = await page(list, ROOT);

    expect(invitationRow(listed, seeded.plain)!.actions).toEqual({
      resend: no('access.unavailable'),
      revoke: yes,
    });
  });

  it('pages accounts and invitations together by id, each row once', async () => {
    const { list } = setUp();
    // An invitation older than every account: ids interleave across the two tables.
    const early = seedInvitation(1, {}, 0x9000);
    const late = seedInvitation(2);

    const seen: string[] = [];
    let after: string | null = null;
    let pages = 0;
    do {
      const current: AdminTeamPage = await page(list, ROOT, { after, limit: 3 });
      seen.push(
        ...current.items.map((row) => (row.type === 'account' ? row.accountId : row.invitationId)),
      );
      after = current.next;
      pages += 1;
    } while (after !== null && pages < 10);

    expect(seen).toEqual([early, ROOT, ROOT2, LEAD, VIEWER, SUPPORT, OFF, late]);
    expect(pages).toBe(3);
    // A last page exactly `limit` long answers next: null.
    const exact = await page(list, ROOT, { after: SUPPORT, limit: 2 });
    expect(exact.items).toHaveLength(2);
    expect(exact.next).toBeNull();
  });

  it('refuses a limit out of range and a malformed after', async () => {
    const { list } = setUp();

    for (const limit of [0, 101, 1.5, Number.NaN]) {
      expect(await list.execute(as(ROOT), { limit })).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'limit', code: 'range' }] },
      });
    }
    expect(await list.execute(as(ROOT), { limit: 5, after: 'not-an-id' })).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'after', code: 'format' }] },
    });
  });

  it('lists nothing of another Market', async () => {
    const { list } = setUp();
    const other = TEST_MARKETS.find((m) => m !== code)!;
    const otherId = id<'Account'>('01990000-0000-7000-8000-00000000d001');
    fakes.seedAccount({
      ...fakes.accounts.get(VIEWER)!,
      id: otherId,
      marketId: other as AccountState['marketId'],
    });
    seedInvitation(9, { marketId: other as AccountState['marketId'] });

    const listed = await page(list, ROOT);

    expect(accountRow(listed, otherId)).toBeUndefined();
    expect(listed.items.every((row) => row.type === 'account')).toBe(true);
  });

  /**
   * An admin with some of the team keys only (Sajad on PR #196): the view key, the reset and the
   * invite keys and `merchant.view`, in a custom role without the system role. SUPPORT holds
   * no `admin-account.view` and so never lists at all (tested above).
   */
  function seedPartial() {
    fakes.seedRole({
      id: PARTIAL_ROLE,
      marketId,
      scope: 'platform',
      kind: 'custom',
      seedCode: null,
      seedVersion: null,
      name: 'Custom role',
      permissionKeys: [
        'identity.admin-account.invite',
        'identity.admin-account.reset-second-factor',
        'identity.admin-account.view',
        'identity.merchant.view',
      ],
      version: 1,
      createdAt: START,
    });
    fakes.seedAccount({
      ...fakes.accounts.get(VIEWER)!,
      id: PARTIAL,
      email: { typed: 'A9@Example.com', normalized: 'a9@example.com' },
    });
    fakes.seedAssignment({
      id: id<'RoleAssignment'>(`01990000-0000-7000-8000-${n12(0xe100 + 9)}`),
      marketId,
      accountId: PARTIAL,
      roleId: PARTIAL_ROLE,
      assignedByAccountId: null,
      assignedAt: START,
      version: 1,
    });
  }

  it("answers member.self on the actor's own row, as each command does (Sajad on PR #196)", async () => {
    const { list, commands } = setUp();

    const own = accountRow(await page(list, ROOT), ROOT)!;

    const answers = {
      changeRole: await commands.changeRole.execute(as(ROOT), {
        accountId: ROOT,
        roleId: roleOf('viewer'),
      }),
      disable: await commands.disable.execute(as(ROOT), { accountId: ROOT }),
      enable: await commands.enable.execute(as(ROOT), { accountId: ROOT }),
      resetSecondFactor: await commands.resetSecondFactor.execute(as(ROOT), { accountId: ROOT }),
    };
    for (const [action, result] of Object.entries(answers)) {
      expect(result).toEqual({ ok: false, error: { code: 'member.self' } });
      expect(own.actions[action as AccountAction]).toEqual(no('member.self'));
    }
  });

  it('answers the actor alone, then an empty page past the last id', async () => {
    const { list } = setUp();
    for (const other of [ROOT2, LEAD, VIEWER, SUPPORT, OFF]) fakes.accounts.delete(other);

    const alone = await page(list, ROOT, { limit: 100 });
    expect(alone.items.map((row) => row.type === 'account' && row.accountId)).toEqual([ROOT]);
    expect(alone.next).toBeNull();
    for (const after of [ROOT, '01990000-0000-7000-8000-ffffffffffff']) {
      expect(await page(list, ROOT, { after, limit: 10 })).toEqual({ items: [], next: null });
    }
  });

  it('pages one row at a time, and accepts the largest page', async () => {
    const { list } = setUp();
    const invited = seedInvitation(1);

    const first = await page(list, ROOT, { limit: 1 });
    expect(first.items.map((row) => row.type === 'account' && row.accountId)).toEqual([ROOT]);
    expect(first.next).toBe(ROOT);
    const seen: string[] = [];
    let after: string | null = null;
    do {
      const current: AdminTeamPage = await page(list, ROOT, { after, limit: 1 });
      expect(current.items).toHaveLength(1);
      seen.push(
        ...current.items.map((row) => (row.type === 'account' ? row.accountId : row.invitationId)),
      );
      after = current.next;
    } while (after !== null);
    expect(seen).toEqual([ROOT, ROOT2, LEAD, VIEWER, SUPPORT, OFF, invited]);
    expect((await page(list, ROOT, { limit: 100 })).items).toHaveLength(7);
  });

  it('answers a next with exactly limit + 1 rows, also when the extra row is an invitation', async () => {
    const { list } = setUp();

    // Six admins, no invitation: the extra row is an account.
    const accounts = await page(list, ROOT, { limit: 5 });
    expect(accounts.items).toHaveLength(5);
    expect(accounts.next).toBe(SUPPORT);
    expect(await page(list, ROOT, { after: SUPPORT, limit: 5 })).toMatchObject({ next: null });

    // Six admins and one invitation after them: the extra row is the invitation.
    const invited = seedInvitation(1);
    const withInvitation = await page(list, ROOT, { limit: 6 });
    expect(withInvitation.items).toHaveLength(6);
    expect(withInvitation.items.every((row) => row.type === 'account')).toBe(true);
    expect(withInvitation.next).toBe(OFF);
    const last = await page(list, ROOT, { after: OFF, limit: 6 });
    expect(last.items.map((row) => row.type === 'invitation' && row.invitationId)).toEqual([
      invited,
    ]);
    expect(last.next).toBeNull();
  });

  describe('every hint is the answer of its command (no second implementation)', () => {
    const actors = [
      [ROOT, 'with'],
      [LEAD, 'with'],
      [VIEWER, 'with'],
      [PARTIAL, 'with'],
      [ROOT, 'without'],
      [PARTIAL, 'without'],
    ] as const;
    const accountActions: readonly AccountAction[] = [
      'changeRole',
      'disable',
      'enable',
      'resetSecondFactor',
    ];
    const invitationActions: readonly InvitationAction[] = ['resend', 'revoke'];

    /** A fresh store with the scenario's state, so each command runs on unchanged data. */
    function scenario(lifetime: 'with' | 'without') {
      const built = setUp({ withoutInvitationLifetime: lifetime === 'without' });
      const seeded = seedInvitations();
      seedPartial();
      seedFactor(ROOT2, 2);
      seedFactor(LEAD, 3);
      seedFactor(OFF, 8);
      return { ...built, seeded };
    }

    it.each(actors)('for actor %s, %s an invitation lifetime', async (actor, lifetime) => {
      const listed = await page(scenario(lifetime).list, actor);
      const codes = new Set<string>();
      let compared = 0;
      for (const row of listed.items) {
        const actions =
          row.type === 'account' ? accountActions : (invitationActions as readonly string[]);
        for (const action of actions) {
          const { commands } = scenario(lifetime);
          let result: Result<unknown, { code: string }>;
          if (row.type === 'account') {
            const input = { accountId: row.accountId };
            result =
              action === 'changeRole'
                ? // A role the actor may grant and that differs from the target's, so the
                  // command's answer is the row's (grantability is not a row hint). Both roles
                  // hold only keys that LEAD holds; Operator is not one of them, as it
                  // holds `identity.merchant.view`, which LEAD lacks (I-1a).
                  await commands.changeRole.execute(as(actor), {
                    ...input,
                    roleId:
                      row.role?.roleId === roleOf('dispatcher')
                        ? roleOf('viewer')
                        : roleOf('dispatcher'),
                  })
                : await commands[action as Exclude<AccountAction, 'changeRole'>].execute(
                    as(actor),
                    input,
                  );
          } else {
            // Revoke reads only the id; the re-send counts its mail on the client's origin too.
            const input = { invitationId: row.invitationId, origin: ORIGIN };
            result = await commands[action as InvitationAction].execute(as(actor), input);
          }
          const hint = (row.actions as Record<string, ActionHint>)[action]!;
          const answer = result.ok ? yes : no(result.error.code);
          expect({ row: row.type, action, answer }).toEqual({
            row: row.type,
            action,
            answer: hint,
          });
          codes.add(answer.code ?? 'allowed');
          compared += 1;
        }
      }
      expect(compared).toBe(7 * 4 + 7 * 2);
      if (lifetime === 'without') expect(codes).toContain('access.unavailable');
      if (actor === PARTIAL) {
        // A partial-key actor gets both kinds of answer.
        expect(codes).toContain('access.denied');
        expect([...codes].some((c) => c !== 'access.denied')).toBe(true);
      }
    });
  });
});
