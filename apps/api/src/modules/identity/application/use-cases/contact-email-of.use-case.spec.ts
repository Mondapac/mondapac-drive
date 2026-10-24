import { parseId, Temporal } from '@mondapac-drive/shared-kernel';
import type { Id, Population } from '@mondapac-drive/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac-drive/shared-kernel/testing';
import { fakeHashOf, IdentityFakes } from '../../../../../test/support/identity-fakes';
import { expectSystemOnly, openGate } from '../../../../../test/support/system-only-denial';
import { PLATFORM_TENANT_ID } from '../../../../platform/market-context/tenant';
import type { AccountState } from '../../domain/account';
import { ContactEmailOf } from './contact-email-of.use-case';

const accountId = (() => {
  const parsed = parseId('01990000-0000-7000-8000-0000000000a1');
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<'Account'>;
})();
const NOW = Temporal.Instant.from('2026-10-24T00:00:00Z');

describe.each([['AU'], ['ZZ']] as const)('identity.contact-email-of in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  let fakes: IdentityFakes;
  beforeEach(() => {
    fakes = new IdentityFakes();
  });
  const seed = (population: Population, overrides: Partial<AccountState> = {}) =>
    fakes.seedAccount({
      id: accountId,
      marketId: market.marketId,
      population,
      email: { typed: 'Me@Example.com', normalized: 'me@example.com' },
      displayName: 'Amina Rahman',
      status: 'active',
      emailVerifiedAt: NOW,
      signedUpAt: NOW,
      createdAt: NOW,
      version: 1,
      credential: { passwordHash: fakeHashOf('x'), changedAt: NOW },
      ...overrides,
    });
  const ask = () =>
    new ContactEmailOf(openGate(), {
      unitOfWork: fakes.unitOfWork,
      accounts: fakes.accountRepository,
    }).execute(testCallContext(market, 'system'), { accountId });

  it('refuses a courier, a merchant, an admin and an anonymous caller', async () => {
    const query = new ContactEmailOf(openGate(), undefined as never);
    await expectSystemOnly(code, (context) => query.execute(context, { accountId }));
  });

  it.each(['admin', 'courier'] as const)('answers the address of an active %s', async (who) => {
    seed(who);
    await expect(ask()).resolves.toEqual({ ok: true, value: 'Me@Example.com' });
  });

  it.each<[string, Population, Partial<AccountState>]>([
    ["a merchant's integration account", 'merchant', {}],
    ['a disabled account', 'courier', { status: 'disabled' }],
    ['an unverified address', 'admin', { emailVerifiedAt: null }],
    ['an account of another Market', 'admin', { marketId: code === 'AU' ? 'ZZ' : 'AU' } as never],
  ])('answers null for %s', async (_name, population, overrides) => {
    seed(population, overrides);
    await expect(ask()).resolves.toEqual({ ok: true, value: null });
  });
});
