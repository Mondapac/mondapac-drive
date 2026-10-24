import { parseId, Temporal } from '@mondapac-drive/shared-kernel';
import type { Id, Population } from '@mondapac-drive/shared-kernel';
import {
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
import { ChangePanelPreferences } from './change-panel-preferences.use-case';

// Changing the own time zone and language (profile package 3), for both Market fixtures.

const START = Temporal.Instant.from('2026-10-16T10:00:00Z');
const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ADMIN_ID = id<'Account'>('01990000-0000-7000-8000-0000000000a1');
const COURIER_ID = id<'Account'>('01990000-0000-7000-8000-0000000000b1');
const MERCHANT_ACCOUNT_ID = id<'Account'>('01990000-0000-7000-8000-0000000000c1');
const MERCHANT_ID = id<'Merchant'>('01990000-0000-7000-8000-0000000000d1');
const SESSION_ID = id<'Session'>('01990000-0000-7000-8000-00000000a001');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const allow: AuthorisationCheck = {
  check: (): Promise<AccessDecision> => Promise.resolve({ allowed: true }),
};

describe.each(TEST_MARKETS)('ChangePanelPreferences in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const gate = createUseCaseGate(markets, allow);
  let fakes: IdentityFakes;

  beforeEach(() => {
    fakes = new IdentityFakes();
  });

  function seed(
    accountId: Id<'Account'>,
    population: Population,
    overrides: Partial<AccountState> = {},
  ) {
    fakes.seedAccount({
      id: accountId,
      marketId: market.marketId,
      population,
      email: { typed: 'Me@Example.com', normalized: 'me@example.com' },
      displayName: 'Amina Rahman',
      status: 'active',
      emailVerifiedAt: START.subtract({ hours: 48 }),
      signedUpAt: START.subtract({ hours: 49 }),
      createdAt: START.subtract({ hours: 49 }),
      version: 3,
      credential: { passwordHash: fakeHashOf('x'), changedAt: START },
      ...overrides,
    });
  }
  const useCase = () =>
    new ChangePanelPreferences(gate, {
      unitOfWork: fakes.unitOfWork,
      accounts: fakes.accountRepository,
    });
  const contextOf = (population: Population, accountId: Id<'Account'>) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId,
        sessionId: SESSION_ID,
        merchantId: population === 'merchant' ? MERCHANT_ID : null,
      }),
    );

  it('declares own-resources', () => {
    expect(ChangePanelPreferences.access).toEqual({
      name: 'identity.change-panel-preferences',
      rule: { kind: 'own-resources' },
    });
  });

  it.each([
    ['admin', ADMIN_ID],
    ['courier', COURIER_ID],
  ] as const)(
    'stores the zone and language of the own %s account',
    async (population, accountId) => {
      seed(accountId, population);

      await expect(
        useCase().execute(contextOf(population, accountId), {
          timezone: 'Australia/Brisbane',
          locale: 'en',
        }),
      ).resolves.toEqual({ ok: true, value: { code: 'panel-preferences-changed', changed: true } });

      expect(fakes.accounts.get(accountId)).toMatchObject({
        timezone: 'Australia/Brisbane',
        locale: 'en',
        version: 4,
      });
    },
  );

  it('accepts UTC and clears a choice with null', async () => {
    seed(ADMIN_ID, 'admin', { timezone: 'Australia/Brisbane', locale: 'en' });

    await expect(
      useCase().execute(contextOf('admin', ADMIN_ID), { timezone: 'UTC', locale: null }),
    ).resolves.toMatchObject({ ok: true, value: { changed: true } });
    await expect(
      useCase().execute(contextOf('admin', ADMIN_ID), { timezone: null, locale: null }),
    ).resolves.toMatchObject({ ok: true, value: { changed: true } });

    expect(fakes.accounts.get(ADMIN_ID)).toMatchObject({ timezone: null, locale: null });
  });

  it('changes nothing for the same values', async () => {
    seed(ADMIN_ID, 'admin');

    await expect(
      useCase().execute(contextOf('admin', ADMIN_ID), { timezone: null, locale: null }),
    ).resolves.toEqual({ ok: true, value: { code: 'panel-preferences-changed', changed: false } });
    expect(fakes.accounts.get(ADMIN_ID)!.version).toBe(3);
  });

  it.each([
    [{ timezone: 'Mars/Olympus', locale: null }, 'timezone'],
    [{ timezone: 'australia/brisbane', locale: null }, 'timezone'],
    [{ timezone: null, locale: 'fr-FR' }, 'locale'],
    [{ timezone: null, locale: '' }, 'locale'],
  ] as const)('refuses %j with a problem on %s', async (input, path) => {
    seed(ADMIN_ID, 'admin');

    await expect(useCase().execute(contextOf('admin', ADMIN_ID), input)).resolves.toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path, code: 'invalid' }] },
    });
    expect(fakes.accounts.get(ADMIN_ID)!.timezone ?? null).toBeNull();
  });

  it("refuses a merchant's API key, an anonymous caller, a disabled account and another population", async () => {
    seed(MERCHANT_ACCOUNT_ID, 'merchant');
    seed(ADMIN_ID, 'admin', { status: 'disabled' });
    seed(COURIER_ID, 'courier');
    const input = { timezone: 'UTC', locale: null };

    await expect(useCase().execute(contextOf('merchant', MERCHANT_ACCOUNT_ID), input)).resolves.toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    await expect(useCase().execute(testCallContext(market, 'anonymous'), input)).resolves.toEqual({
      ok: false,
      error: { code: 'access.unauthenticated' },
    });
    await expect(useCase().execute(contextOf('admin', ADMIN_ID), input)).resolves.toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    await expect(useCase().execute(contextOf('admin', COURIER_ID), input)).resolves.toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    expect(fakes.accounts.get(COURIER_ID)!.timezone ?? null).toBeNull();
  });
});
