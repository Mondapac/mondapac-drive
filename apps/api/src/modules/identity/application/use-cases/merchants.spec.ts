import { createHash } from 'node:crypto';
import { parseId, Temporal } from '@mondapac-drive/shared-kernel';
import type { Id } from '@mondapac-drive/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac-drive/shared-kernel/testing';
import { fakeHashOf, IdentityFakes } from '../../../../../test/support/identity-fakes';
import { realEffectiveKeys } from '../../../../../test/support/permission-registry';
import {
  TEST_MARKETS,
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
} from '../../../../../test/support/test-config';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../../../../platform/market-context/tenant';
import type { AccountState } from '../../domain/account';
import type { RoleState } from '../../domain/role';
import { MarketConfigIdentityPolicy } from '../../infrastructure/market-config-identity-policy';
import { CheckedInRoleSeed } from '../../infrastructure/seed/checked-in-role-seed';
import { RandomSessionTokens } from '../../infrastructure/sessions/random-session-tokens';
import { AccountAuthorisationCheck } from '../access/account-authorisation-check';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import { ReinstateMerchant, SuspendMerchant } from './change-merchant-state.use-case';
import { CreateMerchant, integrationEmailOf } from './create-merchant.use-case';
import { ListMerchants } from './list-merchants.use-case';
import {
  IssueMerchantApiKey,
  ListMerchantApiKeys,
  RevokeMerchantApiKey,
} from './merchant-api-keys.use-case';

// Merchants and their API keys (Drive): create, list, suspend and reinstate a merchant; issue,
// list and revoke its keys. The real gate, registry and checked-in seed; identity's stores as
// fakes. Both Market fixtures: each its own API key lifetime (AU 365 days, ZZ 90).

const START = Temporal.Instant.from('2026-10-24T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const KEY_DAYS: Readonly<Record<string, number>> = { AU: 365, ZZ: 90 };

const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const n12 = (n: number) => String(n).padStart(12, '0');
const accountId = (n: number) => id<'Account'>(`01990000-0000-7000-8000-${n12(0xa000 + n)}`);
const ROOT = accountId(1);
const OPERATOR = accountId(2);
const DISPATCHER = accountId(3);
const UNKNOWN_MERCHANT = id<'Merchant'>('01990000-0000-7000-8000-00000000bfff');

describe.each(TEST_MARKETS)('merchants and API keys in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const marketId = code as AccountState['marketId'];
  let fakes: IdentityFakes;
  let roles: Map<string, RoleState>;
  let clock: FixedClock;

  function setUp(options: { readonly withoutApiKeys?: boolean } = {}) {
    fakes = new IdentityFakes();
    clock = new FixedClock(START);
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
    const admin = (n: number, idOf: Id<'Account'>, seedCode: string) => {
      fakes.seedAccount({
        id: idOf,
        marketId,
        population: 'admin',
        email: { typed: `a${n}@example.com`, normalized: `a${n}@example.com` },
        displayName: `Admin ${n}`,
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
        roleId: roles.get(`platform:${seedCode}`)!.id,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    };
    admin(1, ROOT, 'platform-administrator');
    admin(2, OPERATOR, 'operator');
    admin(3, DISPATCHER, 'dispatcher');

    const effectiveKeys = realEffectiveKeys();
    const gate = createUseCaseGate(
      markets,
      new AccountAuthorisationCheck({
        unitOfWork: fakes.unitOfWork,
        accounts: fakes.accountRepository,
        memberships: fakes.membershipRepository,
        merchants: fakes.merchantRepository,
        grants: fakes.grantReader,
        effectiveKeys,
      }),
    );
    const base = new MarketConfigIdentityPolicy(markets);
    const policy: IdentityMarketPolicy =
      options.withoutApiKeys === true
        ? Object.assign(Object.create(base) as IdentityMarketPolicy, {
            apiKeyLifetime: () => null,
          })
        : base;
    const deps = {
      unitOfWork: fakes.unitOfWork,
      accounts: fakes.accountRepository,
      grants: fakes.grantReader,
      effectiveKeys,
      merchants: fakes.merchantRepository,
      memberships: fakes.membershipRepository,
      sessions: fakes.sessionRepository,
      sessionTokens: new RandomSessionTokens(),
      audit: fakes.audit,
      policy,
      clock,
      ids: new SequenceIdGenerator(clock),
    };
    return {
      create: new CreateMerchant(gate, {
        ...deps,
        roles: fakes.roleRepository,
        assignments: fakes.assignmentRepository,
        hasher: fakes.hasher,
      }),
      list: new ListMerchants(gate, deps),
      suspend: new SuspendMerchant(gate, deps),
      reinstate: new ReinstateMerchant(gate, deps),
      issue: new IssueMerchantApiKey(gate, deps),
      revoke: new RevokeMerchantApiKey(gate, deps),
      keys: new ListMerchantApiKeys(gate, deps),
    };
  }

  const as = (account: Id<'Account'>) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: account,
        sessionId: id<'Session'>('01990000-0000-7000-8000-00000000f001'),
        merchantId: null,
      }),
      'merchants-0001',
    );

  async function created(useCases: ReturnType<typeof setUp>, name = 'Halal Fresh Pty Ltd') {
    const result = await useCases.create.execute(as(ROOT), { name });
    if (!result.ok) throw new Error(`create: ${result.error.code}`);
    return result.value.merchantId;
  }

  describe('CreateMerchant', () => {
    it('creates an active merchant with its integration account, membership and system role, audited by ids', async () => {
      const useCases = setUp();

      const merchantId = await created(useCases);

      expect(fakes.merchants.get(merchantId)).toMatchObject({
        marketId: code,
        name: 'Halal Fresh Pty Ltd',
        state: 'active',
        version: 1,
      });
      const [membership] = [...fakes.memberships.values()];
      expect(membership).toMatchObject({ merchantId, state: 'active', marketId: code });
      const account = fakes.accounts.get(membership!.accountId)!;
      expect(account).toMatchObject({
        population: 'merchant',
        status: 'active',
        emailVerifiedAt: null,
        displayName: 'Halal Fresh Pty Ltd',
        email: { normalized: integrationEmailOf(merchantId) },
      });
      // A reserved, undeliverable address: no mail or sign-up can ever reach it.
      expect(account.email.normalized).toMatch(/@merchant\.invalid$/);
      const assignment = [...fakes.assignments.values()].find((a) => a.accountId === account.id)!;
      expect(assignment.roleId).toBe(roles.get('merchant:merchant')!.id);
      expect(fakes.audits).toEqual([
        expect.objectContaining({
          action: 'identity.merchant.created',
          targetId: merchantId,
          after: { state: 'active', accountId: account.id, roleId: assignment.roleId },
          actor: 'authenticated',
          marketId: code,
        }),
      ]);
      // The name is personal business data: never in an audit row.
      expect(JSON.stringify(fakes.audits)).not.toContain('Halal Fresh');
    });

    it.each([
      ['an empty name', '   '],
      ['a name over 100 characters', 'x'.repeat(101)],
      ['a control character', 'bad\u0007name'],
    ])('refuses %s and writes nothing', async (_case, name) => {
      const { create } = setUp();

      const result = await create.execute(as(ROOT), { name });

      expect(result).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      expect(fakes.merchants.size).toBe(0);
      expect(fakes.audits).toEqual([]);
    });

    it('refuses an operator and a dispatcher: creating a merchant is protected', async () => {
      const { create } = setUp();

      for (const actor of [OPERATOR, DISPATCHER]) {
        await expect(create.execute(as(actor), { name: 'Shop' })).resolves.toEqual({
          ok: false,
          error: { code: 'access.denied' },
        });
      }
      expect(fakes.merchants.size).toBe(0);
    });
  });

  describe('ListMerchants', () => {
    it("lists the Market's merchants to an operator, and refuses a dispatcher", async () => {
      const useCases = setUp();
      const merchantId = await created(useCases);

      const listed = await useCases.list.execute(as(OPERATOR), {});

      expect(listed).toEqual({
        ok: true,
        value: {
          items: [
            {
              merchantId,
              name: 'Halal Fresh Pty Ltd',
              state: 'active',
              stateChangedAt: START,
              createdAt: START,
            },
          ],
        },
      });
      await expect(useCases.list.execute(as(DISPATCHER), {})).resolves.toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
    });
  });

  describe('API keys', () => {
    it("issues a key for the Market's lifetime, stores only its hash, and answers it once", async () => {
      const useCases = setUp();
      const merchantId = await created(useCases);

      const issued = await useCases.issue.execute(as(ROOT), {
        merchantId,
        label: ' Marketplace production ',
      });

      if (!issued.ok) throw new Error(`issue: ${issued.error.code}`);
      const { key, keyId, expiresAt } = issued.value;
      expect(key).toMatch(/^mk1_[A-Za-z0-9_-]{43}$/);
      expect(expiresAt).toEqual(START.add({ hours: 24 * KEY_DAYS[code]! }));
      const stored = fakes.sessions.get(keyId)!;
      expect(stored.session).toMatchObject({
        population: 'merchant',
        merchantId,
        transport: 'api-key',
        label: 'Marketplace production',
      });
      expect(stored.tokenHash).toBe(
        Buffer.from(createHash('sha256').update(key).digest()).toString('hex'),
      );
      expect(JSON.stringify([fakes.audits, [...fakes.sessions.values()]])).not.toContain(key);
      expect(fakes.audits.at(-1)).toMatchObject({
        action: 'identity.api-key.issued',
        targetId: keyId,
        after: { merchantId },
      });
    });

    it('lists the live keys without a secret, and revokes one key of this merchant only', async () => {
      const useCases = setUp();
      const merchantId = await created(useCases);
      const otherId = await created(useCases, 'Another Shop');
      const first = await useCases.issue.execute(as(ROOT), { merchantId, label: 'First' });
      const theirs = await useCases.issue.execute(as(ROOT), { merchantId: otherId, label: 'X' });
      if (!first.ok || !theirs.ok) throw new Error('issue');

      const listed = await useCases.keys.execute(as(OPERATOR), { merchantId });
      expect(listed.ok && listed.value.items.map((row) => [row.keyId, row.label])).toEqual([
        [first.value.keyId, 'First'],
      ]);
      expect(JSON.stringify(listed)).not.toContain(first.value.key);

      // Another merchant's key is unknown here, as is a missing one.
      for (const keyId of [
        theirs.value.keyId,
        id<'Session'>('01990000-0000-7000-8000-0000000fffff'),
      ]) {
        await expect(useCases.revoke.execute(as(ROOT), { merchantId, keyId })).resolves.toEqual({
          ok: false,
          error: { code: 'api-key.unknown' },
        });
      }
      await expect(
        useCases.revoke.execute(as(ROOT), { merchantId, keyId: first.value.keyId }),
      ).resolves.toEqual({
        ok: true,
        value: { code: 'api-key.revoked', keyId: first.value.keyId },
      });
      // Twice is unknown: a revoked key is no longer live.
      await expect(
        useCases.revoke.execute(as(ROOT), { merchantId, keyId: first.value.keyId }),
      ).resolves.toEqual({ ok: false, error: { code: 'api-key.unknown' } });
      const after = await useCases.keys.execute(as(OPERATOR), { merchantId });
      expect(after.ok && after.value.items).toEqual([]);
      expect(fakes.sessions.get(theirs.value.keyId)!.session.revokedAt).toBeNull();
    });

    it.each([
      ['an empty label', '  ', 'length'],
      ['a label over 64 characters', 'x'.repeat(65), 'length'],
      ['a bidi override', 'bad‮label', 'characters'],
    ])('refuses %s', async (_case, label, rule) => {
      const useCases = setUp();
      const merchantId = await created(useCases);

      await expect(useCases.issue.execute(as(ROOT), { merchantId, label })).resolves.toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'label', code: rule }] },
      });
    });

    it('refuses an unknown merchant, a Market without a key lifetime, and an operator', async () => {
      const useCases = setUp();
      await expect(
        useCases.issue.execute(as(ROOT), { merchantId: UNKNOWN_MERCHANT, label: 'K' }),
      ).resolves.toEqual({ ok: false, error: { code: 'merchant.unknown' } });
      const merchantId = await created(useCases);
      await expect(
        useCases.issue.execute(as(OPERATOR), { merchantId, label: 'K' }),
      ).resolves.toEqual({ ok: false, error: { code: 'access.denied' } });

      const failClosed = setUp({ withoutApiKeys: true });
      const other = await created(failClosed);
      await expect(
        failClosed.issue.execute(as(ROOT), { merchantId: other, label: 'K' }),
      ).resolves.toEqual({ ok: false, error: { code: 'access.unavailable' } });
    });
  });

  describe('SuspendMerchant and ReinstateMerchant', () => {
    it('suspends a merchant and revokes every key at once; a suspended merchant gets no new key', async () => {
      const useCases = setUp();
      const merchantId = await created(useCases);
      // One after the other: each issue steps the merchant's version (a concurrent one is stale).
      const keys = [
        await useCases.issue.execute(as(ROOT), { merchantId, label: 'A' }),
        await useCases.issue.execute(as(ROOT), { merchantId, label: 'B' }),
      ];

      await expect(useCases.suspend.execute(as(ROOT), { merchantId })).resolves.toEqual({
        ok: true,
        value: { code: 'merchant.suspended', merchantId },
      });

      expect(fakes.merchants.get(merchantId)!.state).toBe('suspended');
      for (const key of keys) {
        if (!key.ok) throw new Error('issue');
        expect(fakes.sessions.get(key.value.keyId)!.session.revokedReason).toBe(
          'merchant-suspended',
        );
      }
      expect(fakes.audits.at(-1)).toMatchObject({
        action: 'identity.merchant.suspended',
        before: { state: 'active' },
        after: { state: 'suspended', revokedSessions: 2 },
      });
      await expect(useCases.issue.execute(as(ROOT), { merchantId, label: 'C' })).resolves.toEqual({
        ok: false,
        error: { code: 'merchant.suspended' },
      });
    });

    it('reinstates a suspended merchant; its revoked keys stay revoked', async () => {
      const useCases = setUp();
      const merchantId = await created(useCases);
      const key = await useCases.issue.execute(as(ROOT), { merchantId, label: 'A' });
      if (!key.ok) throw new Error('issue');
      await useCases.suspend.execute(as(ROOT), { merchantId });

      await expect(useCases.reinstate.execute(as(ROOT), { merchantId })).resolves.toEqual({
        ok: true,
        value: { code: 'merchant.reinstated', merchantId },
      });

      expect(fakes.merchants.get(merchantId)!.state).toBe('active');
      expect(fakes.sessions.get(key.value.keyId)!.session.revokedAt).not.toBeNull();
      expect(fakes.audits.at(-1)).toMatchObject({ action: 'identity.merchant.reinstated' });
    });

    it('refuses a change to the state it is in, an unknown merchant, and a dispatcher', async () => {
      const useCases = setUp();
      const merchantId = await created(useCases);

      const reinstateActive = await useCases.reinstate.execute(as(ROOT), { merchantId });
      expect(reinstateActive.ok).toBe(false);
      await useCases.suspend.execute(as(ROOT), { merchantId });
      const suspendSuspended = await useCases.suspend.execute(as(ROOT), { merchantId });
      expect(suspendSuspended.ok).toBe(false);
      await expect(
        useCases.suspend.execute(as(ROOT), { merchantId: UNKNOWN_MERCHANT }),
      ).resolves.toEqual({ ok: false, error: { code: 'merchant.unknown' } });
      await expect(useCases.reinstate.execute(as(DISPATCHER), { merchantId })).resolves.toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
    });
  });
});
