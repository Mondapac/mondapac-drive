import path from 'node:path';
import { parseMarketId, type MarketId } from '@mondapac-drive/shared-kernel';
import { loadAppConfig, type AppConfig } from '../../src/platform/config/app-config';

const REPO_ROOT = path.resolve(__dirname, '../../../..');

/** The real Market configuration plus the synthetic second market used by tests. */
export const TEST_MARKET_CONFIG_DIRS = [
  path.join(REPO_ROOT, 'config/markets'),
  path.join(REPO_ROOT, 'test/fixtures/markets'),
] as const;

/** The real ServiceArea configuration plus the synthetic market's areas. */
export const TEST_SERVICE_AREA_CONFIG_DIRS = [
  path.join(REPO_ROOT, 'config/service-areas'),
  path.join(REPO_ROOT, 'test/fixtures/service-areas'),
] as const;

/** Both market fixtures (ADR-0003 decision 9): the launch market and a synthetic one. */
export const TEST_MARKETS = ['AU', 'ZZ'] as const;

/** A Market code parsed with the kernel's rule; a malformed code is a mistake in the test. */
export function testMarketId(code: string): MarketId {
  const parsed = parseMarketId(code);
  if (!parsed.ok) throw new Error(`testMarketId: malformed market code "${code}"`);
  return parsed.value;
}

/** {@link TEST_MARKETS} as parsed Market ids. */
export const TEST_MARKET_IDS: readonly MarketId[] = TEST_MARKETS.map(testMarketId);

/**
 * Application config for tests: both markets hosted, the `api` role, logging quiet unless
 * overridden (`testAppConfig({ APP_ROLE: 'worker' })` for the worker role).
 */
export function testAppConfig(overrides: Record<string, string> = {}): AppConfig {
  return {
    ...loadAppConfig({
      NODE_ENV: 'test',
      APP_ROLE: 'api',
      HOSTED_MARKETS: TEST_MARKETS.join(','),
      // Never connected to unless a suite overrides it with a real database.
      DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:1/unused',
      ...overrides,
    }),
    marketConfigDirs: TEST_MARKET_CONFIG_DIRS,
    serviceAreaConfigDirs: TEST_SERVICE_AREA_CONFIG_DIRS,
  };
}
