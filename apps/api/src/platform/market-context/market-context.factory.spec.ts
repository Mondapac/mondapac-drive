import { isMinted, parseTenantId } from '@mondapac-drive/shared-kernel';
import type { TenantId } from '@mondapac-drive/shared-kernel';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKETS,
  testMarketId,
} from '../../../test/support/test-config';
import { loadMarketConfigs } from '../market-config/market-config';
import { MarketRegistry } from '../market-config/market-registry';
import { MarketContextFactory } from './market-context.factory';
import { PLATFORM_TENANT_ID } from './tenant';

function factoryHosting(
  codes: readonly string[],
  tenantId: TenantId = PLATFORM_TENANT_ID,
): MarketContextFactory {
  const registry = new MarketRegistry(
    loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, codes.map(testMarketId)),
  );
  return new MarketContextFactory(registry, tenantId);
}

const NOT_HOSTED = { ok: false, error: { code: 'market.not-hosted' } };
const INVALID = { ok: false, error: { code: 'market-id.invalid' } };

describe('MarketContextFactory', () => {
  const factory = factoryHosting(TEST_MARKETS);

  it.each(TEST_MARKETS)(
    'mints the context of hosted market %s with the platform tenant',
    (code) => {
      const result = factory.forMarket(code);

      expect(result).toEqual({ ok: true, value: { marketId: code, tenantId: 'mondapac' } });
      if (!result.ok) throw new Error('unreachable');
      expect(isMinted(result.value)).toBe(true);
      expect(Object.isFrozen(result.value)).toBe(true);
    },
  );

  it.each(TEST_MARKETS)('mints a new context on every call for %s', (code) => {
    const first = factory.forMarket(code);
    const second = factory.forMarket(code);

    expect(first.ok && second.ok && first.value !== second.value).toBe(true);
  });

  it.each(TEST_MARKETS)(
    'in a Region Stack hosting only %s, refuses every other market and serves its own',
    (code) => {
      const single = factoryHosting([code]);

      expect(single.forMarket(code).ok).toBe(true);
      for (const other of TEST_MARKETS.filter((market) => market !== code)) {
        expect(single.forMarket(other)).toEqual(NOT_HOSTED);
      }
    },
  );

  it('refuses a well-formed market that is not hosted, and substitutes no other', () => {
    expect(factory.forMarket('NZ')).toEqual(NOT_HOSTED);
    expect(factory.forMarket('QQ_LEAK7')).toEqual(NOT_HOSTED);
  });

  it.each(
    TEST_MARKETS.flatMap((code) => [
      code.toLowerCase(),
      ` ${code}`,
      `${code} `,
      `${code}\n`,
      `${code}-X`,
      `${code}TOOLONGX`,
      `${code}, ${code}`,
      TEST_MARKETS.join(', '),
    ]),
  )('refuses the malformed code %p before asking the registry', (code) => {
    expect(factory.forMarket(code)).toEqual(INVALID);
  });

  it.each(['', 'A', '1A', '_A', 'A B'])('refuses the malformed code %p', (code) => {
    expect(factory.forMarket(code)).toEqual(INVALID);
  });

  it('refuses a value that is not a string at run time', () => {
    expect(factory.forMarket([...TEST_MARKETS] as unknown as string)).toEqual(INVALID);
    expect(factory.forMarket(undefined as unknown as string)).toEqual(INVALID);
  });

  it.each(TEST_MARKETS)('takes the tenant from its injected token (%s)', (code) => {
    const tenant = parseTenantId('another-tenant');
    if (!tenant.ok) throw new Error('unreachable');

    const result = factoryHosting(TEST_MARKETS, tenant.value).forMarket(code);

    expect(result).toEqual({ ok: true, value: { marketId: code, tenantId: 'another-tenant' } });
  });

  it('uses the platform tenant constant mondapac (ADR-0020 decision 6)', () => {
    expect(PLATFORM_TENANT_ID).toBe('mondapac');
    expect(parseTenantId(PLATFORM_TENANT_ID).ok).toBe(true);
  });
});
