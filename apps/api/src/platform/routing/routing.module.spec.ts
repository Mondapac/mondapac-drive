import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../test/support/test-config';
import { loadMarketConfigs } from '../market-config/market-config';
import { MarketRegistry } from '../market-config/market-registry';
import { routingConfigSchema } from './routing-config';
import { marketRoutingFor } from './routing.module';

const registry = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

describe('marketRoutingFor', () => {
  it("builds a road client from each Market's own key variable", () => {
    const warnings: unknown[] = [];
    const routing = marketRoutingFor(
      registry,
      { GOOGLE_MAPS_API_KEY: 'au-key', ZZ_ROUTING_API_KEY: 'zz-key' },
      { warn: (message: unknown) => void warnings.push(message) },
    );
    for (const marketId of TEST_MARKET_IDS) expect(routing.get(marketId)!.road).toBeDefined();
    expect(warnings).toEqual([]);
  });

  it('routes by straight line, with a warning that names no key, when the variable is unset', () => {
    const warnings: unknown[] = [];
    const routing = marketRoutingFor(
      registry,
      { GOOGLE_MAPS_API_KEY: '  ' },
      { warn: (message: unknown) => void warnings.push(message) },
    );
    for (const marketId of TEST_MARKET_IDS) expect(routing.get(marketId)!.road).toBeUndefined();
    expect(warnings).toHaveLength(2);
    expect(JSON.stringify(warnings)).toContain('routing.key-missing');
  });
});

describe('routingConfigSchema', () => {
  const valid = {
    provider: 'straight_line',
    timeoutMs: 1000,
    cacheTtlSeconds: 0,
    cacheCoordinateDecimals: 4,
    circuitBreaker: { failureThreshold: 1, openSeconds: 1 },
    straightLine: { roadFactor: 1.2, speedsKmh: { bicycle: 10, motorbike: 20, car: 20, van: 20 } },
  };

  it('accepts a straight-line Market', () => {
    expect(routingConfigSchema.safeParse(valid).success).toBe(true);
  });

  it('requires the google section for the google provider', () => {
    expect(routingConfigSchema.safeParse({ ...valid, provider: 'google' }).success).toBe(false);
  });

  it('refuses a key in place of a variable name', () => {
    const google = {
      apiKeyEnv: 'AIzaSy-not-a-name',
      regionCode: 'au',
      travelModes: { bicycle: 'BICYCLE', motorbike: 'DRIVE', car: 'DRIVE', van: 'DRIVE' },
      trafficAware: false,
    };
    expect(routingConfigSchema.safeParse({ ...valid, provider: 'google', google }).success).toBe(
      false,
    );
  });
});
