import { ConfigNotificationSettingsProvider } from '../../src/modules/notifications/infrastructure/config-notification-settings.provider';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from './test-config';

/** The notification settings of the real AU file and the synthetic ZZ market. */
export const notificationSettings = new ConfigNotificationSettingsProvider(
  new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS)),
);
