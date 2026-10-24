import { isMinted } from '@mondapac-drive/shared-kernel';
import type { MarketContext } from '@mondapac-drive/shared-kernel';
import { testMarketContext } from '@mondapac-drive/shared-kernel/testing';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
} from '../../../test/support/test-config';
import { loadMarketConfigs } from '../market-config/market-config';
import { MarketRegistry } from '../market-config/market-registry';
import { MarketContextFactory } from './market-context.factory';
import { attachMarketContext } from './attached-market-context';
import { marketContextOf, MissingMarketContextError } from './market.decorator';
import { PLATFORM_TENANT_ID } from './tenant';

describe('the MarketContext of a request', () => {
  const factory = new MarketContextFactory(
    new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS)),
    PLATFORM_TENANT_ID,
  );

  function minted(code: string): MarketContext {
    const result = factory.forMarket(code);
    if (!result.ok) throw new Error(`unreachable: ${result.error.code}`);
    return result.value;
  }

  it.each(TEST_MARKETS)('reads back the very context attached for %s', (code) => {
    const request = {};
    const market = minted(code);

    attachMarketContext(request, market);

    expect(marketContextOf(request)).toBe(market);
  });

  it('keeps the contexts of two requests apart', () => {
    const [first, second] = [{}, {}];
    const [a, b] = TEST_MARKETS.map(minted);
    attachMarketContext(first, a!);
    attachMarketContext(second, b!);

    expect(marketContextOf(first)).toBe(a);
    expect(marketContextOf(second)).toBe(b);
  });

  it('throws when nothing is attached, and never defaults', () => {
    expect(() => marketContextOf({})).toThrow(MissingMarketContextError);
  });

  it.each(TEST_MARKETS)('refuses a context that was not minted (%s)', (code) => {
    const market = minted(code);
    const forgeries = [
      { marketId: market.marketId, tenantId: market.tenantId },
      { ...market },
      JSON.parse(JSON.stringify(market)) as unknown,
      Object.freeze({ ...market }),
    ] as unknown as MarketContext[];

    for (const forgery of forgeries) {
      const request = {};
      expect(() => attachMarketContext(request, forgery)).toThrow(TypeError);
      expect(() => marketContextOf(request)).toThrow(MissingMarketContextError);
    }
  });

  it('refuses a second context on the same request', () => {
    const request = {};
    const [first, second] = TEST_MARKETS.map(minted);
    attachMarketContext(request, first!);

    expect(() => attachMarketContext(request, second!)).toThrow(/already/);
    expect(marketContextOf(request)).toBe(first);
  });

  // Platform-foundations design 3.7: the main entry and `/testing` resolve to one copy of the
  // kernel, so a context built by the test builders passes the platform's minted check.
  it.each(TEST_MARKETS)('accepts a context built through /testing for %s (one kernel)', (code) => {
    const request = {};
    const market = testMarketContext(code, PLATFORM_TENANT_ID);

    expect(isMinted(market)).toBe(true);
    attachMarketContext(request, market);
    expect(marketContextOf(request)).toBe(market);
  });
});
