import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

/** The real translation catalogues plus the synthetic market's locale (ZZ: en-ZZ). */
export const TEST_LOCALE_CONFIG_DIRS = [
  path.join(REPO_ROOT, 'config/locales'),
  path.join(REPO_ROOT, 'test/fixtures/locales'),
] as const;

interface RawMarketFile {
  allowedOrigins: Record<'admin' | 'merchant' | 'courier', string[]>;
  identity: { links: { targets: Partial<Record<'admin' | 'courier', Record<string, string>>> } };
}

function readMarketFiles(): Map<string, RawMarketFile> {
  const files = new Map<string, RawMarketFile>();
  for (const directory of TEST_MARKET_CONFIG_DIRS) {
    for (const name of readdirSync(directory).filter((file) => file.endsWith('.json'))) {
      files.set(
        path.basename(name, '.json'),
        JSON.parse(readFileSync(path.join(directory, name), 'utf8')) as RawMarketFile,
      );
    }
  }
  return files;
}

/** The origin of the admin panel's link pages in a Market's checked-in configuration. */
function panelOriginOf(file: RawMarketFile): string {
  const pages = Object.values(file.identity.links.targets.admin ?? {});
  const origins = new Set(pages.map((page) => new URL(page).origin));
  if (origins.size !== 1) throw new Error(`expected one admin panel origin, found ${origins.size}`);
  return [...origins][0]!;
}

let panelDirs: readonly string[] | undefined;

/**
 * Test-only Market configuration for HTTP tests of admin routes (identity design 6.4). Admin
 * routes refuse every unsafe request whose `Origin` is not on the admin list, and AU's list stays
 * empty until the dispatch panel's host is known, so the real AU file refuses them all (tested
 * in `test/route-population.e2e.spec.ts`, "applies the checked-in list"). Here an empty admin
 * list is filled with the origin of the admin link pages, the value the panel is expected to
 * configure; every other value is the checked-in one, and a list already set (ZZ) is kept.
 * Written once per test process to a temporary folder. Tests only: no path under `src/` may
 * import it.
 */
export function panelOriginMarketConfigDirs(): readonly string[] {
  if (panelDirs !== undefined) return panelDirs;
  const directory = mkdtempSync(path.join(tmpdir(), 'markets-panel-'));
  for (const [code, file] of readMarketFiles()) {
    if (file.allowedOrigins.admin.length === 0) file.allowedOrigins.admin = [panelOriginOf(file)];
    writeFileSync(path.join(directory, `${code}.json`), JSON.stringify(file));
  }
  panelDirs = Object.freeze([directory]);
  return panelDirs;
}

/**
 * The origin headers the dispatch panel's BFF sends with an unsafe request (ADR-0034 decision
 * 3): `Origin` equal to the admin panel's origin in the Market (the origin of its link pages)
 * and `Sec-Fetch-Site: same-origin`.
 */
export function panelHeaders(code: string): {
  readonly origin: string;
  readonly 'sec-fetch-site': 'same-origin';
} {
  const file = readMarketFiles().get(code);
  if (file === undefined) throw new Error(`panelHeaders: no Market file for ${code}`);
  return { origin: panelOriginOf(file), 'sec-fetch-site': 'same-origin' };
}

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
    localeConfigDirs: TEST_LOCALE_CONFIG_DIRS,
  };
}
