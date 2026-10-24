import { ConfigPayoutSettingsProvider } from '../../src/modules/payouts/infrastructure/config-payout-settings.provider';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, testMarketId } from './test-config';

/**
 * The payout settings of the real AU file and the synthetic ZZ market: AUD with GST for
 * registered contractors, a weekly run and an ABN requirement, against JPY (no minor unit), a
 * daily run, tax on tips and no business-id requirement.
 */
export const payoutMarkets = new ConfigPayoutSettingsProvider(
  new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS)),
);

export const AU = testMarketId('AU');
export const ZZ = testMarketId('ZZ');
