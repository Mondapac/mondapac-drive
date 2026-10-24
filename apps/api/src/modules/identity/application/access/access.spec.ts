import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { isMinted, parseId, Temporal } from '@mondapac-drive/shared-kernel';
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
import { TEST_MARKETS } from '../../../../../test/support/test-config';
import { PLATFORM_TENANT_ID } from '../../../../platform/market-context/tenant';
import type { UnitOfWork, UnitOfWorkOptions } from '../../../../platform/unit-of-work/unit-of-work';
import {
  SELLER_ACCESS_APPROVE,
  SELLER_ACCESS_VIEW,
  TEAM_MEMBER_INVITE,
  TEAM_MEMBER_VIEW,
} from '../../contracts/permissions';
import type { AccountState } from '../../domain/account';
import type { RoleKind, RoleScope } from '../../domain/role';
import type { SellerAccessStateCode } from '../../domain/seller-access';
import { openSession, type Session } from '../../domain/session';
import type { SessionTokens } from '../ports/session-secrets';
import { AccountAuthorisationCheck } from './account-authorisation-check';
import { SessionAuthenticator } from './session-authenticator';

// sellers' key by its literal: identity's tests never import another module's contracts.
const SELLERS_BUSINESS_IDENTITY_EDIT = { key: 'sellers.business-identity.edit' } as const;

// identity design 4, 5.2, 6.2 (slice 2): the Authenticator and the AuthorisationCheck, for both
// Market fixtures.

const START = Temporal.Instant.from('2026-10-08T10:00:00Z');
const TOKEN = `ms1_${'Q'.repeat(43)}`;
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ACCOUNT_ID = id<'Account'>('01990000-0000-7000-8000-000000000001');
const SESSION_ID = id<'Session'>('01990000-0000-7000-8000-00000000a001');
const SELLER_ID = id<'Seller'>('01990000-0000-7000-8000-00000000b001');
const OTHER_SELLER_ID = id<'Seller'>('01990000-0000-7000-8000-00000000b002');
const ROLE_ID = id<'Role'>('01990000-0000-7000-8000-00000000d001');
const ASSIGNMENT_ID = id<'RoleAssignment'>('01990000-0000-7000-8000-00000000e001');

/**
 * Gives {@link ACCOUNT_ID} a role, as a test fixture: the role row and the assignment written
 * through the fakes. Admin fixture accounts exist only in tests (PA 14 condition 1).
 */
function grantRole(
  fakes: IdentityFakes,
  code: string,
  role: {
    readonly scope: RoleScope;
    readonly kind: RoleKind;
    readonly keys?: readonly string[];
    readonly sellerId?: Id<'Seller'> | null;
  },
): void {
  const marketId = code as AccountState['marketId'];
  const seeded = role.kind !== 'custom';
  fakes.seedRole({
    id: ROLE_ID,
    marketId,
    scope: role.scope,
    kind: role.kind,
    seedCode: seeded ? 'fixture-role' : null,
    seedVersion: seeded ? 1 : null,
    sellerId: role.sellerId ?? null,
    permissionKeys: role.keys ?? [],
    version: 1,
    createdAt: START,
  });
  fakes.seedAssignment({
    id: ASSIGNMENT_ID,
    marketId,
    accountId: ACCOUNT_ID,
    roleId: ROLE_ID,
    assignedByAccountId: null,
    assignedAt: START,
    version: 1,
  });
}

const tokens: SessionTokens = {
  issue: () => {
    throw new Error('not issued here');
  },
  hashOf: (token) =>
    /^ms1_/.test(token) ? new Uint8Array(createHash('sha256').update(token).digest()) : null,
};

function account(code: string, overrides: Partial<AccountState> = {}): AccountState {
  return {
    id: ACCOUNT_ID,
    marketId: code as AccountState['marketId'],
    population: 'customer',
    email: { typed: 'a@example.com', normalized: 'a@example.com' },
    displayName: null,
    status: 'active',
    emailVerifiedAt: START,
    existingAccountNoticeAt: null,
    signedUpAt: START,
    createdAt: START,
    version: 1,
    credential: { passwordHash: fakeHashOf('x'), changedAt: START },
    ...overrides,
  };
}

/** A seller-side account working for {@link SELLER_ID}, in the given access state. */
function seedSeller(
  fakes: IdentityFakes,
  code: string,
  state: SellerAccessStateCode,
  membership: 'active' | 'none' | 'other-seller' = 'active',
): void {
  const marketId = code as AccountState['marketId'];
  fakes.seedAccount(account(code, { population: 'seller', displayName: 'Amina' }));
  fakes.seedSellerAccess({
    sellerId: SELLER_ID,
    marketId,
    origin: 'self',
    state,
    stateChangedAt: START,
    reapplyCount: 0,
    registeredAt: START,
    version: 1,
    createdAt: START,
  });
  fakes.memberships.clear();
  if (membership === 'none') return;
  fakes.seedMembership({
    id: id<'SellerMembership'>('01990000-0000-7000-8000-00000000c001'),
    marketId,
    accountId: ACCOUNT_ID,
    sellerId: membership === 'active' ? SELLER_ID : OTHER_SELLER_ID,
    state: 'active',
    removedAt: null,
    version: 1,
    createdAt: START,
  });
}

describe.each(TEST_MARKETS)('identity access ports in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  let fakes: IdentityFakes;
  let clock: FixedClock;
  let units: (UnitOfWorkOptions | undefined)[];
  let unitOfWork: UnitOfWork;
  let warnings: jest.SpyInstance;

  beforeEach(() => {
    fakes = new IdentityFakes();
    clock = new FixedClock(START);
    units = [];
    unitOfWork = {
      run: <T, E>(
        m: MarketContext,
        work: () => Promise<Result<T, E>>,
        options?: UnitOfWorkOptions,
      ) => {
        units.push(options);
        return fakes.unitOfWork.run(m, work);
      },
      runOnce: (m, delivery, work, options) => fakes.unitOfWork.runOnce(m, delivery, work, options),
    };
    warnings = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    fakes.seedAccount(account(code));
  });
  afterEach(() => warnings.mockRestore());

  function seedSession(overrides: Partial<Session> = {}): Session {
    const session = {
      ...openSession({
        id: SESSION_ID,
        marketId: market.marketId,
        accountId: ACCOUNT_ID,
        population: 'customer',
        transport: 'cookie',
        lifetime: LIFETIME,
        now: START,
      }),
      ...overrides,
    };
    void fakes.sessionRepository.add(market, session, tokens.hashOf(TOKEN)!);
    return session;
  }

  describe('SessionAuthenticator', () => {
    const authenticator = () =>
      new SessionAuthenticator({ unitOfWork, sessions: fakes.sessionRepository, tokens, clock });

    function seedSellerSession(): void {
      void fakes.sessionRepository.add(
        market,
        openSession({
          id: SESSION_ID,
          marketId: market.marketId,
          accountId: ACCOUNT_ID,
          population: 'seller',
          sellerId: SELLER_ID,
          transport: 'cookie',
          lifetime: LIFETIME,
          now: START,
        }),
        tokens.hashOf(TOKEN)!,
      );
    }

    it.each<SellerAccessStateCode>(['pending', 'approved', 'rejected'])(
      'builds a seller actor carrying the session seller (%s seller; slice 5)',
      async (state) => {
        seedSeller(fakes, code, state);
        seedSellerSession();

        const result = await authenticator().authenticate(market, {
          token: TOKEN,
          transport: 'cookie',
        });

        expect(result.ok && result.value).toMatchObject({
          kind: 'authenticated',
          population: 'seller',
          accountId: ACCOUNT_ID,
          sellerId: SELLER_ID,
        });
      },
    );

    it.each<[string, SellerAccessStateCode, 'none' | 'other-seller' | 'active']>([
      ['a seller session without an active membership', 'approved', 'none'],
      ['a seller session whose membership is of another seller', 'approved', 'other-seller'],
      ['a seller session of a suspended seller', 'suspended', 'active'],
    ])('rejects %s with the one credential.rejected', async (_case, state, membership) => {
      seedSeller(fakes, code, state, membership);
      seedSellerSession();

      await expect(
        authenticator().authenticate(market, { token: TOKEN, transport: 'cookie' }),
      ).resolves.toEqual({ ok: false, error: { code: 'credential.rejected' } });
    });

    it('builds a minted customer actor from a live session, in a read-only unit', async () => {
      seedSession();

      const result = await authenticator().authenticate(market, {
        token: TOKEN,
        transport: 'cookie',
      });

      expect(result.ok).toBe(true);
      const actor = result.ok ? result.value : null;
      expect(isMinted(actor)).toBe(true);
      expect(actor).toMatchObject({
        kind: 'authenticated',
        marketId: code,
        population: 'customer',
        accountId: ACCOUNT_ID,
        sessionId: SESSION_ID,
        sellerId: null,
      });
      // The read is read-only; no lastSeenAt write within the minute.
      expect(units).toEqual([{ readOnly: true }]);
    });

    it('writes lastSeenAt once a minute has passed, in a read-write unit of its own', async () => {
      seedSession();
      clock.advance(Temporal.Duration.from({ seconds: 61 }));

      await authenticator().authenticate(market, { token: TOKEN, transport: 'cookie' });

      expect(units).toEqual([{ readOnly: true }, undefined]);
      expect(fakes.sessions.get(SESSION_ID)!.session.lastSeenAt).toEqual(clock.now());
    });

    it('still authenticates when the lastSeenAt write fails, and logs it', async () => {
      seedSession();
      clock.advance(Temporal.Duration.from({ minutes: 5 }));
      fakes.sessionRepository.touch = () => Promise.reject(new Error('down'));

      const result = await authenticator().authenticate(market, {
        token: TOKEN,
        transport: 'cookie',
      });

      expect(result.ok).toBe(true);
      expect(warnings).toHaveBeenCalledWith(
        expect.objectContaining({ msg: 'identity.session.last-seen-not-written' }),
      );
    });

    it.each<[string, () => void, { token?: string; transport?: 'cookie' | 'bearer' }]>([
      ['an unknown token', () => seedSession(), { token: `ms1_${'Z'.repeat(43)}` }],
      ['a malformed token', () => seedSession(), { token: 'not-a-token' }],
      ['the other transport', () => seedSession(), { transport: 'bearer' }],
      ['a revoked session', () => seedSession({ revokedAt: START, revokedReason: 'sign-out' }), {}],
      [
        'an idle session',
        () => {
          seedSession();
          clock.advance(Temporal.Duration.from({ seconds: LIFETIME.idleTimeoutSeconds }));
        },
        {},
      ],
      [
        'an expired session',
        () => {
          seedSession({ lastSeenAt: START.add({ seconds: 7000 }) });
          clock.advance(Temporal.Duration.from({ seconds: LIFETIME.absoluteLifetimeSeconds }));
        },
        {},
      ],
      [
        'a disabled account',
        () => {
          seedSession();
          fakes.seedAccount(account(code, { status: 'disabled' }));
        },
        {},
      ],
    ])('rejects %s with the one credential.rejected', async (_case, arrange, credential) => {
      arrange();

      await expect(
        authenticator().authenticate(market, {
          token: credential.token ?? TOKEN,
          transport: credential.transport ?? 'cookie',
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'credential.rejected' } });
    });

    it('rejects a session of another Market (AC 20)', async () => {
      seedSession();
      const other = testMarketContext(
        TEST_MARKETS.find((m) => m !== code)!,
        PLATFORM_TENANT_ID,
      );

      await expect(
        authenticator().authenticate(other, { token: TOKEN, transport: 'cookie' }),
      ).resolves.toEqual({ ok: false, error: { code: 'credential.rejected' } });
    });
  });

  describe('AccountAuthorisationCheck', () => {
    const check = () =>
      new AccountAuthorisationCheck({
        unitOfWork,
        accounts: fakes.accountRepository,
        memberships: fakes.membershipRepository,
        sellerAccess: fakes.sellerAccessRepository,
        grants: fakes.grantReader,
        effectiveKeys: realEffectiveKeys(),
      });
    const needs = (...keys: string[]) => ({
      name: 'identity.anything',
      rule: { kind: 'permissions' as const, allOf: keys as never },
    });
    const ALLOWED = { allowed: true };
    const DENIED = { allowed: false, denial: { code: 'access.denied' } };
    const actorContext = (population: 'customer' | 'admin' = 'customer') =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population,
          accountId: ACCOUNT_ID,
          sessionId: SESSION_ID,
          sellerId: null,
        }),
      );
    const ownResources = {
      name: 'identity.sign-out',
      rule: { kind: 'own-resources' as const },
      whenSellerNotApproved: 'allow' as const,
    };

    it('allows own-resources for an active account of the actor, read in a read-only unit', async () => {
      await expect(check().check(actorContext(), ownResources)).resolves.toEqual({ allowed: true });
      expect(units).toEqual([{ readOnly: true }]);
    });

    it('denies a disabled account, and an account of another population', async () => {
      fakes.seedAccount(account(code, { status: 'disabled' }));
      await expect(check().check(actorContext(), ownResources)).resolves.toEqual({
        allowed: false,
        denial: { code: 'access.denied' },
      });
      fakes.seedAccount(account(code));
      await expect(check().check(actorContext('admin'), ownResources)).resolves.toMatchObject({
        allowed: false,
      });
    });

    it('denies a permissions rule to a customer before any read: a customer holds no key (R2)', async () => {
      await expect(check().check(actorContext(), needs(SELLER_ACCESS_VIEW.key))).resolves.toEqual(
        DENIED,
      );
      expect(units).toEqual([]);
    });

    describe('the permission path for an admin fixture account (slice 8a-1)', () => {
      beforeEach(() =>
        fakes.seedAccount(account(code, { population: 'admin', displayName: 'Admin' })),
      );

      it('the Platform Administrator holds every platform key of the registry, read in one read-only unit', async () => {
        grantRole(fakes, code, { scope: 'platform', kind: 'system' });
        const registry = realPermissionRegistry();
        for (const { key } of registry.list('platform')) {
          await expect(check().check(actorContext('admin'), needs(key))).resolves.toEqual(ALLOWED);
        }
        await expect(
          check().check(
            actorContext('admin'),
            needs(...registry.list('platform').map((d) => d.key)),
          ),
        ).resolves.toEqual(ALLOWED);
        expect(units.length).toBeGreaterThan(0);
        expect(units.every((u) => u?.readOnly === true)).toBe(true);
      });

      it('a default role holds its stored keys only, and allOf needs every key', async () => {
        grantRole(fakes, code, {
          scope: 'platform',
          kind: 'default',
          keys: [SELLER_ACCESS_VIEW.key, SELLER_ACCESS_APPROVE.key],
        });
        await expect(
          check().check(actorContext('admin'), needs(SELLER_ACCESS_APPROVE.key)),
        ).resolves.toEqual(ALLOWED);
        await expect(
          check().check(
            actorContext('admin'),
            needs(SELLER_ACCESS_APPROVE.key, 'identity.customer-account.view'),
          ),
        ).resolves.toEqual(DENIED);
      });

      it('R7: a stored key the registry does not declare grants nothing', async () => {
        grantRole(fakes, code, {
          scope: 'platform',
          kind: 'custom',
          keys: ['identity.seller-access.approve-all'],
        });
        await expect(
          check().check(actorContext('admin'), needs('identity.seller-access.approve-all')),
        ).resolves.toEqual(DENIED);
      });

      it('R2: a key of the seller scope is never held by an admin, even the Platform Administrator', async () => {
        grantRole(fakes, code, { scope: 'platform', kind: 'system' });
        await expect(
          check().check(actorContext('admin'), needs(TEAM_MEMBER_VIEW.key)),
        ).resolves.toEqual(DENIED);
        // A seller-scope role assigned to an admin (a corrupt row) grants nothing either.
        grantRole(fakes, code, { scope: 'seller', kind: 'system' });
        await expect(
          check().check(actorContext('admin'), needs(TEAM_MEMBER_VIEW.key)),
        ).resolves.toEqual(DENIED);
      });

      it('no role, no key; and a disabled admin is denied whatever its role', async () => {
        await expect(
          check().check(actorContext('admin'), needs(SELLER_ACCESS_VIEW.key)),
        ).resolves.toEqual(DENIED);
        grantRole(fakes, code, { scope: 'platform', kind: 'system' });
        fakes.seedAccount(
          account(code, { population: 'admin', displayName: 'Admin', status: 'disabled' }),
        );
        await expect(
          check().check(actorContext('admin'), needs(SELLER_ACCESS_VIEW.key)),
        ).resolves.toEqual(DENIED);
      });

      it('R4: reads the role on every call, so a removed role takes effect at once', async () => {
        grantRole(fakes, code, {
          scope: 'platform',
          kind: 'default',
          keys: [SELLER_ACCESS_VIEW.key],
        });
        await expect(
          check().check(actorContext('admin'), needs(SELLER_ACCESS_VIEW.key)),
        ).resolves.toEqual(ALLOWED);
        fakes.assignments.clear();
        await expect(
          check().check(actorContext('admin'), needs(SELLER_ACCESS_VIEW.key)),
        ).resolves.toEqual(DENIED);
      });
    });

    describe('for the seller population (slice 5)', () => {
      const sellerContext = (sellerId: Id<'Seller'> = SELLER_ID) =>
        testCallContext(
          market,
          testAuthenticatedActor(market, {
            population: 'seller',
            accountId: ACCOUNT_ID,
            sessionId: SESSION_ID,
            sellerId,
          }),
        );
      const notAllowListed = {
        name: 'identity.anything',
        rule: { kind: 'own-resources' as const },
      };

      it('allows an approved seller, reading account, membership and seller in one read-only unit', async () => {
        seedSeller(fakes, code, 'approved');

        await expect(check().check(sellerContext(), notAllowListed)).resolves.toEqual({
          allowed: true,
        });
        expect(units).toEqual([{ readOnly: true }]);
      });

      it.each<'pending' | 'rejected'>(['pending', 'rejected'])(
        'answers access.seller-not-approved with the state to a %s seller off the allow-list',
        async (state) => {
          seedSeller(fakes, code, state);

          await expect(check().check(sellerContext(), notAllowListed)).resolves.toEqual({
            allowed: false,
            denial: { code: 'access.seller-not-approved', details: { state } },
          });
          await expect(check().check(sellerContext(), ownResources)).resolves.toEqual({
            allowed: true,
          });
        },
      );

      it('denies a suspended seller even on the allow-list', async () => {
        seedSeller(fakes, code, 'suspended');

        await expect(check().check(sellerContext(), ownResources)).resolves.toEqual({
          allowed: false,
          denial: { code: 'access.denied' },
        });
      });

      it('denies without a membership, or with a membership of another seller than the actor', async () => {
        seedSeller(fakes, code, 'approved', 'none');
        await expect(check().check(sellerContext(), ownResources)).resolves.toMatchObject({
          allowed: false,
        });
        seedSeller(fakes, code, 'approved', 'other-seller');
        await expect(check().check(sellerContext(), ownResources)).resolves.toMatchObject({
          allowed: false,
        });
        seedSeller(fakes, code, 'approved');
        await expect(
          check().check(sellerContext(OTHER_SELLER_ID), ownResources),
        ).resolves.toMatchObject({ allowed: false });
      });

      it('decides the seller state first under a permissions rule, then the keys', async () => {
        grantRole(fakes, code, { scope: 'seller', kind: 'system' });
        seedSeller(fakes, code, 'pending');
        await expect(
          check().check(sellerContext(), needs(TEAM_MEMBER_VIEW.key)),
        ).resolves.toMatchObject({ denial: { code: 'access.seller-not-approved' } });
        seedSeller(fakes, code, 'approved');
        await expect(check().check(sellerContext(), needs(TEAM_MEMBER_VIEW.key))).resolves.toEqual(
          ALLOWED,
        );
      });

      it('the Seller Owner holds every seller key of every module, protected ones too (R3)', async () => {
        grantRole(fakes, code, { scope: 'seller', kind: 'system' });
        seedSeller(fakes, code, 'approved');
        for (const key of [
          TEAM_MEMBER_VIEW.key,
          TEAM_MEMBER_INVITE.key,
          SELLERS_BUSINESS_IDENTITY_EDIT.key,
        ]) {
          await expect(check().check(sellerContext(), needs(key))).resolves.toEqual(ALLOWED);
        }
        await expect(
          check().check(sellerContext(), needs(SELLER_ACCESS_VIEW.key)),
        ).resolves.toEqual(DENIED);
      });

      it('a Staff member holds its default role keys only', async () => {
        grantRole(fakes, code, {
          scope: 'seller',
          kind: 'default',
          keys: [TEAM_MEMBER_VIEW.key, 'identity.seller-role.view'],
        });
        seedSeller(fakes, code, 'approved');
        await expect(check().check(sellerContext(), needs(TEAM_MEMBER_VIEW.key))).resolves.toEqual(
          ALLOWED,
        );
        await expect(
          check().check(sellerContext(), needs(SELLERS_BUSINESS_IDENTITY_EDIT.key)),
        ).resolves.toEqual(DENIED);
      });

      it("R9: a custom role of another seller grants nothing to this seller's member", async () => {
        seedSeller(fakes, code, 'approved');
        grantRole(fakes, code, {
          scope: 'seller',
          kind: 'custom',
          keys: [TEAM_MEMBER_VIEW.key],
          sellerId: OTHER_SELLER_ID,
        });
        await expect(check().check(sellerContext(), needs(TEAM_MEMBER_VIEW.key))).resolves.toEqual(
          DENIED,
        );
        grantRole(fakes, code, {
          scope: 'seller',
          kind: 'custom',
          keys: [TEAM_MEMBER_VIEW.key],
          sellerId: SELLER_ID,
        });
        await expect(check().check(sellerContext(), needs(TEAM_MEMBER_VIEW.key))).resolves.toEqual(
          ALLOWED,
        );
      });

      it('a suspended seller is denied even with the system role', async () => {
        grantRole(fakes, code, { scope: 'seller', kind: 'system' });
        seedSeller(fakes, code, 'suspended');
        await expect(check().check(sellerContext(), needs(TEAM_MEMBER_VIEW.key))).resolves.toEqual(
          DENIED,
        );
      });
    });
  });
});
