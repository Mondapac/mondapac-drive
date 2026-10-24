import { parseId, Temporal } from '@mondapac-drive/shared-kernel';
import type { Id } from '@mondapac-drive/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac-drive/shared-kernel/testing';
import { fakeHashOf, IdentityFakes } from '../../../../../test/support/identity-fakes';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
} from '../../../../../test/support/test-config';
import type { AccessDecision, AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../../../../platform/market-context/tenant';
import type { AccountState } from '../../domain/account';
import { ChangeDisplayName } from './change-display-name.use-case';

// Changing the own display name (profile package), for both Market fixtures.

const START = Temporal.Instant.from('2026-10-16T10:00:00Z');
const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ADMIN_ID = id<'Account'>('01990000-0000-7000-8000-0000000000a1');
const SELLER_ACCOUNT_ID = id<'Account'>('01990000-0000-7000-8000-0000000000b1');
const CUSTOMER_ID = id<'Account'>('01990000-0000-7000-8000-0000000000c1');
const SELLER_ID = id<'Seller'>('01990000-0000-7000-8000-0000000000d1');
const SESSION_ID = id<'Session'>('01990000-0000-7000-8000-00000000a001');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const allow: AuthorisationCheck = {
  check: (): Promise<AccessDecision> => Promise.resolve({ allowed: true }),
};

describe.each(TEST_MARKETS)('ChangeDisplayName in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const gate = createUseCaseGate(markets, allow);
  let fakes: IdentityFakes;

  beforeEach(() => {
    fakes = new IdentityFakes();
  });

  function seed(
    accountId: Id<'Account'>,
    population: 'admin' | 'seller' | 'customer',
    overrides: Partial<AccountState> = {},
  ) {
    fakes.seedAccount({
      id: accountId,
      marketId: market.marketId,
      population,
      email: { typed: 'Me@Example.com', normalized: 'me@example.com' },
      displayName: population === 'customer' ? null : 'Amina Rahman',
      status: 'active',
      emailVerifiedAt: START.subtract({ hours: 48 }),
      existingAccountNoticeAt: null,
      signedUpAt: START.subtract({ hours: 49 }),
      createdAt: START.subtract({ hours: 49 }),
      version: 3,
      credential: { passwordHash: fakeHashOf('x'), changedAt: START },
      ...overrides,
    });
  }
  const useCase = () =>
    new ChangeDisplayName(gate, {
      unitOfWork: fakes.unitOfWork,
      accounts: fakes.accountRepository,
      outbox: fakes.outbox,
      clock: new FixedClock(START),
    });
  const contextOf = (population: 'admin' | 'seller' | 'customer', accountId: Id<'Account'>) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId,
        sessionId: SESSION_ID,
        sellerId: population === 'seller' ? SELLER_ID : null,
      }),
    );
  const events = () =>
    fakes.events.filter((e) => e.type === 'identity.account-display-name-changed.v1');

  it('declares own-resources, allowed for a seller that is not approved', () => {
    expect(ChangeDisplayName.access).toEqual({
      name: 'identity.change-display-name',
      rule: { kind: 'own-resources' },
      whenSellerNotApproved: 'allow',
    });
  });

  it.each([
    ['admin', ADMIN_ID],
    ['seller', SELLER_ACCOUNT_ID],
  ] as const)(
    'renames the own %s account, trimmed, and records one event without the name',
    async (population, accountId) => {
      seed(accountId, population);

      await expect(
        useCase().execute(contextOf(population, accountId), { displayName: '  Amina R.  ' }),
      ).resolves.toEqual({ ok: true, value: { code: 'display-name-changed', changed: true } });

      expect(fakes.accounts.get(accountId)).toMatchObject({ displayName: 'Amina R.', version: 4 });
      expect(events()).toEqual([expect.objectContaining({ payload: { accountId, population } })]);
      expect(JSON.stringify(events())).not.toContain('Amina');
    },
  );

  it('changes nothing and records nothing for the same name', async () => {
    seed(ADMIN_ID, 'admin');

    await expect(
      useCase().execute(contextOf('admin', ADMIN_ID), { displayName: ' Amina Rahman ' }),
    ).resolves.toEqual({ ok: true, value: { code: 'display-name-changed', changed: false } });

    expect(fakes.accounts.get(ADMIN_ID)).toMatchObject({ displayName: 'Amina Rahman', version: 3 });
    expect(events()).toEqual([]);
  });

  it.each([
    ['', 'length'],
    ['   ', 'length'],
    ['x'.repeat(101), 'length'],
    ['Amina‮Rahman', 'characters'],
  ] as const)('refuses the name %j with the field problem %s', async (displayName, rule) => {
    seed(ADMIN_ID, 'admin');

    await expect(useCase().execute(contextOf('admin', ADMIN_ID), { displayName })).resolves.toEqual(
      {
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'displayName', code: rule }] },
      },
    );
    expect(fakes.accounts.get(ADMIN_ID)!.displayName).toBe('Amina Rahman');
  });

  it('refuses URL-like text', async () => {
    seed(ADMIN_ID, 'admin');

    await expect(
      useCase().execute(contextOf('admin', ADMIN_ID), { displayName: 'www.example.com' }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'validation.failed' } });
  });

  it('sets the first name of a customer account, which starts with none', async () => {
    seed(CUSTOMER_ID, 'customer');

    await expect(
      useCase().execute(contextOf('customer', CUSTOMER_ID), { displayName: '  Amina  ' }),
    ).resolves.toEqual({ ok: true, value: { code: 'display-name-changed', changed: true } });
    expect(fakes.accounts.get(CUSTOMER_ID)).toMatchObject({ displayName: 'Amina', version: 4 });
  });

  it('refuses an unverified customer and the anonymous caller', async () => {
    seed(CUSTOMER_ID, 'customer', { emailVerifiedAt: null });

    await expect(
      useCase().execute(contextOf('customer', CUSTOMER_ID), { displayName: 'Amina' }),
    ).resolves.toEqual({ ok: false, error: { code: 'access.denied' } });
    await expect(
      useCase().execute(testCallContext(market, 'anonymous'), { displayName: 'Amina' }),
    ).resolves.toEqual({ ok: false, error: { code: 'access.unauthenticated' } });
    expect(fakes.accounts.get(CUSTOMER_ID)!.displayName).toBeNull();
  });

  it('refuses a disabled account and an account of another population than the session', async () => {
    seed(ADMIN_ID, 'admin', { status: 'disabled' });
    seed(SELLER_ACCOUNT_ID, 'seller');

    await expect(
      useCase().execute(contextOf('admin', ADMIN_ID), { displayName: 'Amina' }),
    ).resolves.toEqual({ ok: false, error: { code: 'access.denied' } });
    await expect(
      useCase().execute(contextOf('admin', SELLER_ACCOUNT_ID), { displayName: 'Amina' }),
    ).resolves.toEqual({ ok: false, error: { code: 'access.denied' } });
    expect(fakes.accounts.get(SELLER_ACCOUNT_ID)!.displayName).toBe('Amina Rahman');
  });
});
