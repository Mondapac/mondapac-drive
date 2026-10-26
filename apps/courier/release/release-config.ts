/**
 * What `app.config.ts` needs to know about the build it describes. Pure, so the rules are
 * tested without the Expo CLI: the variant (development, preview, production), the app's
 * version from the release tag, the store identifiers, and the API and Market a release build
 * serves.
 *
 * The API URL and the Market come from the build's environment (EAS environment variables, or
 * the CI job's), never from a literal here: one binary per Market and per API. A preview or
 * production build without them fails while the config is read, not on a tester's phone.
 *
 * A demo build is the one exception: it runs on the bundled sample data (EXPO_PUBLIC_DEMO=1),
 * talks to no API and says so on every screen, so people can try every screen without an
 * account. It installs beside the others and never goes to a store.
 */
export type Variant = 'development' | 'preview' | 'production' | 'demo';

export interface ReleaseConfig {
  readonly variant: Variant;
  /** Marketing version, `MAJOR.MINOR.PATCH`: the store shows it. */
  readonly version: string;
  /** Monotonic build number: Android `versionCode`, iOS `CFBundleVersion`. */
  readonly buildNumber: number;
  /** iOS bundle identifier and Android package; each variant installs beside the others. */
  readonly applicationId: string;
  /** The home-screen name suffix that tells testers which build they hold. */
  readonly nameSuffix: string;
  /** Set for preview and production; development may run on the mock, demo always does. */
  readonly apiUrl: string | undefined;
  readonly marketId: string | undefined;
}

export const BASE_APPLICATION_ID = 'com.mondapac.drive.courier';

const VARIANTS: readonly Variant[] = ['development', 'preview', 'production', 'demo'];
const SUFFIX: Readonly<Record<Variant, string>> = {
  development: ' (Dev)',
  preview: ' (Preview)',
  production: '',
  demo: ' (Demo)',
};
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
/** Android refuses a versionCode above this. */
const MAX_BUILD_NUMBER = 2_100_000_000;

export function resolveRelease(
  source: Readonly<Record<string, string | undefined>>,
  packageVersion: string,
  marketExists: (code: string) => boolean,
): ReleaseConfig {
  const variant = (source.APP_VARIANT?.trim() || 'development') as Variant;
  if (!VARIANTS.includes(variant)) {
    throw new Error(`APP_VARIANT must be one of ${VARIANTS.join(', ')}`);
  }
  const version = versionFrom(source.APP_VERSION, packageVersion);
  const buildNumber = buildNumberFrom(source.APP_BUILD_NUMBER);
  const apiUrl = source.EXPO_PUBLIC_API_URL?.trim() || undefined;
  const marketId = source.EXPO_PUBLIC_MARKET_ID?.trim() || undefined;

  const demo = source.EXPO_PUBLIC_DEMO === '1';
  if (variant === 'demo') {
    if (!demo) throw new Error('A demo build needs EXPO_PUBLIC_DEMO=1');
    if (apiUrl)
      throw new Error('A demo build runs on sample data and takes no EXPO_PUBLIC_API_URL');
  } else if (demo) {
    throw new Error(`EXPO_PUBLIC_DEMO is for the demo variant, not ${variant}`);
  }

  if (variant === 'preview' || variant === 'production') {
    if (!apiUrl || !/^https:\/\/[^\s/]+/.test(apiUrl)) {
      throw new Error(`A ${variant} build needs an https EXPO_PUBLIC_API_URL`);
    }
    if (source.EXPO_PUBLIC_API_MODE === 'mock') {
      throw new Error(`A ${variant} build cannot use the mock API`);
    }
    if (!marketId || !/^[A-Z]{2,8}$/.test(marketId) || !marketExists(marketId)) {
      throw new Error(`A ${variant} build needs EXPO_PUBLIC_MARKET_ID naming a configured Market`);
    }
  }

  return {
    variant,
    version,
    buildNumber,
    applicationId:
      variant === 'production' ? BASE_APPLICATION_ID : `${BASE_APPLICATION_ID}.${variant}`,
    nameSuffix: SUFFIX[variant],
    apiUrl,
    marketId,
  };
}

/** `courier-v1.4.0` (the release tag), `v1.4.0` or `1.4.0`; the package version otherwise. */
export function versionFrom(tag: string | undefined, packageVersion: string): string {
  const raw = tag?.trim().replace(/^(courier-)?v/, '') || packageVersion;
  if (!SEMVER.test(raw)) {
    throw new Error(`The app version must be MAJOR.MINOR.PATCH, got "${raw}"`);
  }
  return raw;
}

function buildNumberFrom(raw: string | undefined): number {
  if (!raw?.trim()) return 1;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_BUILD_NUMBER) {
    throw new Error('APP_BUILD_NUMBER must be a positive whole number');
  }
  return value;
}
