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
import { COURIER_ACCOUNT_INVITE, MERCHANT_VIEW } from '../../contracts/permissions';
import type { AccountState } from '../../domain/account';
import type { MerchantStateCode } from '../../domain/merchant';
import type { RoleKind, RoleScope } from '../../domain/role';
import { openSession, type Session } from '../../domain/session';
import type { SessionTokens } from '../ports/session-secrets';
import { AccountAuthorisationCheck } from './account-authorisation-check';
import { SessionAuthenticator } from './session-authenticator';

// delivery's keys by their literal: identity's tests never import another module's contracts.
const BOOKING_CREATE = { key: 'delivery.booking.create' } as const;
const ASSIGNMENT_REPORT = { key: 'delivery.assignment.report' } as const;

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
const MERCHANT_ID = id<'Merchant'>('01990000-0000-7000-8000-00000000b001');
const OTHER_MERCHANT_ID = id<'Merchant'>('01990000-0000-7000-8000-00000000b002');
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
    population: 'courier',
    email: { typed: 'a@example.com', normalized: 'a@example.com' },
    displayName: 'Amina',
    status: 'active',
    emailVerifiedAt: START,
    signedUpAt: START,
    createdAt: START,
    version: 1,
    credential: { passwordHash: fakeHashOf('x'), changedAt: START },
    ...overrides,
  };
}

/** A merchant's integration account working for {@link MERCHANT_ID}, in the given state. */
function seedMerchant(
  fakes: IdentityFakes,
  code: string,
  state: MerchantStateCode,
  membership: 'active' | 'none' | 'other-merchant' = 'active',
): void {
  const marketId = code as AccountState['marketId'];
  fakes.seedAccount(account(code, { population: 'merchant', emailVerifiedAt: null }));
  fakes.seedMerchant({
    id: MERCHANT_ID,
    marketId,
    name: 'Corner Grocer',
    state,
    stateChangedAt: START,
    version: 1,
    createdAt: START,
  });
  fakes.memberships.clear();
  if (membership === 'none') return;
  fakes.seedMembership({
    id: id<'MerchantMembership'>('01990000-0000-7000-8000-00000000c001'),
    marketId,
    accountId: ACCOUNT_ID,
    merchantId: membership === 'active' ? MERCHANT_ID : OTHER_MERCHANT_ID,
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
        population: 'courier',
        transport: 'bearer',
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

    function seedApiKey(): void {
      void fakes.sessionRepository.add(
        market,
        openSession({
          id: SESSION_ID,
          marketId: market.marketId,
          accountId: ACCOUNT_ID,
          population: 'merchant',
          merchantId: MERCHANT_ID,
          transport: 'api-key',
          label: 'Warehouse',
          lifetime: LIFETIME,
          now: START,
        }),
        tokens.hashOf(TOKEN)!,
      );
    }

    it('builds a merchant actor carrying the API key merchant', async () => {
      seedMerchant(fakes, code, 'active');
      seedApiKey();

      const result = await authenticator().authenticate(market, {
        token: TOKEN,
        transport: 'api-key',
      });

      expect(result.ok && result.value).toMatchObject({
        kind: 'authenticated',
        population: 'merchant',
        accountId: ACCOUNT_ID,
        merchantId: MERCHANT_ID,
      });
    });

    it.each<[string, MerchantStateCode, 'none' | 'other-merchant' | 'active', string]>([
      ['an API key without an active membership', 'active', 'none', 'api-key'],
      ['an API key whose membership is of another merchant', 'active', 'other-merchant', 'api-key'],
      ['an API key of a suspended merchant', 'suspended', 'active', 'api-key'],
      ['an API key presented as a courier bearer token', 'active', 'active', 'bearer'],
    ])(
      'rejects %s with the one credential.rejected',
      async (_case, state, membership, transport) => {
        seedMerchant(fakes, code, state, membership);
        seedApiKey();

        await expect(
          authenticator().authenticate(market, {
            token: TOKEN,
            transport: transport as 'api-key' | 'bearer',
          }),
        ).resolves.toEqual({ ok: false, error: { code: 'credential.rejected' } });
      },
    );

    it('builds a minted courier actor from a live session, in a read-only unit', async () => {
      seedSession();

      const result = await authenticator().authenticate(market, {
        token: TOKEN,
        transport: 'bearer',
      });

      expect(result.ok).toBe(true);
      const actor = result.ok ? result.value : null;
      expect(isMinted(actor)).toBe(true);
      expect(actor).toMatchObject({
        kind: 'authenticated',
        marketId: code,
        population: 'courier',
        accountId: ACCOUNT_ID,
        sessionId: SESSION_ID,
        merchantId: null,
      });
      // The read is read-only; no lastSeenAt write within the minute.
      expect(units).toEqual([{ readOnly: true }]);
    });

    it('writes lastSeenAt once a minute has passed, in a read-write unit of its own', async () => {
      seedSession();
      clock.advance(Temporal.Duration.from({ seconds: 61 }));

      await authenticator().authenticate(market, { token: TOKEN, transport: 'bearer' });

      expect(units).toEqual([{ readOnly: true }, undefined]);
      expect(fakes.sessions.get(SESSION_ID)!.session.lastSeenAt).toEqual(clock.now());
    });

    it('never writes lastSeenAt for a re-check with touch: false (tracking PR #18, M1)', async () => {
      seedSession();
      const before = fakes.sessions.get(SESSION_ID)!.session.lastSeenAt;
      clock.advance(Temporal.Duration.from({ minutes: 5 }));

      const result = await authenticator().authenticate(
        market,
        { token: TOKEN, transport: 'bearer' },
        { touch: false },
      );

      expect(result.ok).toBe(true);
      expect(units).toEqual([{ readOnly: true }]);
      expect(fakes.sessions.get(SESSION_ID)!.session.lastSeenAt).toEqual(before);
    });

    it('still authenticates when the lastSeenAt write fails, and logs it', async () => {
      seedSession();
      clock.advance(Temporal.Duration.from({ minutes: 5 }));
      fakes.sessionRepository.touch = () => Promise.reject(new Error('down'));

      const result = await authenticator().authenticate(market, {
        token: TOKEN,
        transport: 'bearer',
      });

      expect(result.ok).toBe(true);
      expect(warnings).toHaveBeenCalledWith(
        expect.objectContaining({ msg: 'identity.session.last-seen-not-written' }),
      );
    });

    it.each<[string, () => void, { token?: string; transport?: 'cookie' | 'api-key' }]>([
      ['an unknown token', () => seedSession(), { token: `ms1_${'Z'.repeat(43)}` }],
      ['a malformed token', () => seedSession(), { token: 'not-a-token' }],
      ['the cookie transport', () => seedSession(), { transport: 'cookie' }],
      ['the API key transport', () => seedSession(), { transport: 'api-key' }],
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
          transport: credential.transport ?? 'bearer',
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
        authenticator().authenticate(other, { token: TOKEN, transport: 'bearer' }),
      ).resolves.toEqual({ ok: false, error: { code: 'credential.rejected' } });
    });
  });

  describe('AccountAuthorisationCheck', () => {
    const check = () =>
      new AccountAuthorisationCheck({
        unitOfWork,
        accounts: fakes.accountRepository,
        memberships: fakes.membershipRepository,
        merchants: fakes.merchantRepository,
        grants: fakes.grantReader,
        effectiveKeys: realEffectiveKeys(),
      });
    const needs = (...keys: string[]) => ({
      name: 'identity.anything',
      rule: { kind: 'permissions' as const, allOf: keys as never },
    });
    const ALLOWED = { allowed: true };
    const DENIED = { allowed: false, denial: { code: 'access.denied' } };
    const actorContext = (population: 'courier' | 'admin' = 'courier') =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population,
          accountId: ACCOUNT_ID,
          sessionId: SESSION_ID,
          merchantId: null,
        }),
      );
    const ownResources = {
      name: 'identity.sign-out',
      rule: { kind: 'own-resources' as const },
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

    it('denies a courier a platform key, even with the courier system role (R2)', async () => {
      grantRole(fakes, code, { scope: 'courier', kind: 'system' });
      await expect(check().check(actorContext(), needs(MERCHANT_VIEW.key))).resolves.toEqual(
        DENIED,
      );
      await expect(check().check(actorContext(), needs(ASSIGNMENT_REPORT.key))).resolves.toEqual(
        ALLOWED,
      );
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
          keys: [MERCHANT_VIEW.key, COURIER_ACCOUNT_INVITE.key],
        });
        await expect(
          check().check(actorContext('admin'), needs(COURIER_ACCOUNT_INVITE.key)),
        ).resolves.toEqual(ALLOWED);
        await expect(
          check().check(
            actorContext('admin'),
            needs(COURIER_ACCOUNT_INVITE.key, 'identity.admin-account.view'),
          ),
        ).resolves.toEqual(DENIED);
      });

      it('R7: a stored key the registry does not declare grants nothing', async () => {
        grantRole(fakes, code, {
          scope: 'platform',
          kind: 'custom',
          keys: ['identity.merchant.approve-all'],
        });
        await expect(
          check().check(actorContext('admin'), needs('identity.merchant.approve-all')),
        ).resolves.toEqual(DENIED);
      });

      it('R2: a merchant key is never held by an admin, even the Platform Administrator', async () => {
        grantRole(fakes, code, { scope: 'platform', kind: 'system' });
        await expect(
          check().check(actorContext('admin'), needs(BOOKING_CREATE.key)),
        ).resolves.toEqual(DENIED);
        // A merchant-scope role assigned to an admin (a corrupt row) grants nothing either.
        grantRole(fakes, code, { scope: 'merchant', kind: 'system' });
        await expect(
          check().check(actorContext('admin'), needs(BOOKING_CREATE.key)),
        ).resolves.toEqual(DENIED);
      });

      it('no role, no key; and a disabled admin is denied whatever its role', async () => {
        await expect(
          check().check(actorContext('admin'), needs(MERCHANT_VIEW.key)),
        ).resolves.toEqual(DENIED);
        grantRole(fakes, code, { scope: 'platform', kind: 'system' });
        fakes.seedAccount(
          account(code, { population: 'admin', displayName: 'Admin', status: 'disabled' }),
        );
        await expect(
          check().check(actorContext('admin'), needs(MERCHANT_VIEW.key)),
        ).resolves.toEqual(DENIED);
      });

      it('R4: reads the role on every call, so a removed role takes effect at once', async () => {
        grantRole(fakes, code, {
          scope: 'platform',
          kind: 'default',
          keys: [MERCHANT_VIEW.key],
        });
        await expect(
          check().check(actorContext('admin'), needs(MERCHANT_VIEW.key)),
        ).resolves.toEqual(ALLOWED);
        fakes.assignments.clear();
        await expect(
          check().check(actorContext('admin'), needs(MERCHANT_VIEW.key)),
        ).resolves.toEqual(DENIED);
      });
    });

    describe('for the merchant population (API keys)', () => {
      const merchantContext = (merchantId: Id<'Merchant'> = MERCHANT_ID) =>
        testCallContext(
          market,
          testAuthenticatedActor(market, {
            population: 'merchant',
            accountId: ACCOUNT_ID,
            sessionId: SESSION_ID,
            merchantId,
          }),
        );

      it('allows an active merchant, reading account, membership and merchant in one read-only unit', async () => {
        seedMerchant(fakes, code, 'active');

        await expect(check().check(merchantContext(), ownResources)).resolves.toEqual(ALLOWED);
        expect(units).toEqual([{ readOnly: true }]);
      });

      it('denies a suspended merchant, whatever the rule', async () => {
        grantRole(fakes, code, { scope: 'merchant', kind: 'system' });
        seedMerchant(fakes, code, 'suspended');

        await expect(check().check(merchantContext(), ownResources)).resolves.toEqual(DENIED);
        await expect(check().check(merchantContext(), needs(BOOKING_CREATE.key))).resolves.toEqual(
          DENIED,
        );
      });

      it('denies without a membership, or with a membership of another merchant than the actor', async () => {
        seedMerchant(fakes, code, 'active', 'none');
        await expect(check().check(merchantContext(), ownResources)).resolves.toEqual(DENIED);
        seedMerchant(fakes, code, 'active', 'other-merchant');
        await expect(check().check(merchantContext(), ownResources)).resolves.toEqual(DENIED);
        seedMerchant(fakes, code, 'active');
        await expect(
          check().check(merchantContext(OTHER_MERCHANT_ID), ownResources),
        ).resolves.toEqual(DENIED);
      });

      it('the merchant system role holds every merchant key and no platform or courier key (R2, R3)', async () => {
        grantRole(fakes, code, { scope: 'merchant', kind: 'system' });
        seedMerchant(fakes, code, 'active');
        const registry = realPermissionRegistry();
        for (const { key } of registry.list('merchant')) {
          await expect(check().check(merchantContext(), needs(key))).resolves.toEqual(ALLOWED);
        }
        await expect(check().check(merchantContext(), needs(MERCHANT_VIEW.key))).resolves.toEqual(
          DENIED,
        );
        await expect(
          check().check(merchantContext(), needs(ASSIGNMENT_REPORT.key)),
        ).resolves.toEqual(DENIED);
      });

      it('denies a merchant actor whose account is of another population (a corrupt session)', async () => {
        seedMerchant(fakes, code, 'active');
        fakes.seedAccount(account(code, { population: 'courier' }));

        await expect(check().check(merchantContext(), ownResources)).resolves.toEqual(DENIED);
      });
    });
  });
});
