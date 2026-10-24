import { ConfigMarketSettingsProvider } from '../../src/modules/delivery/infrastructure/config-market-settings.provider';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { loadServiceAreas } from '../../src/platform/market-config/service-area-config';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_SERVICE_AREA_CONFIG_DIRS,
  testMarketId,
} from './test-config';

/** The delivery settings of the real AU file and the synthetic ZZ market (other currency, tax and limits). */
export const markets = new ConfigMarketSettingsProvider(
  new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS)),
  loadServiceAreas(TEST_SERVICE_AREA_CONFIG_DIRS, TEST_MARKET_IDS),
);

export const AU = testMarketId('AU');
export const ZZ = testMarketId('ZZ');
