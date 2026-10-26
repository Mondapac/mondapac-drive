/**
 * Build-time settings (EXPO_PUBLIC_*, inlined by the Expo bundler). Without an API URL the app
 * runs on the mock adapter, so it works before the backend routes exist.
 */
export type ApiMode = 'mock' | 'http';

export interface AppEnv {
  readonly apiMode: ApiMode;
  readonly apiUrl: string | undefined;
  /** The Market this build serves (EXPO_PUBLIC_MARKET_ID); sign-in is scoped to it. */
  readonly marketId: string | undefined;
  /** A demo build (EXPO_PUBLIC_DEMO=1): sample data only, shown as such on every screen. */
  readonly demo: boolean;
}

/**
 * A release build refuses to start without an https API: the mock would accept every
 * delivery locally and nothing would reach the server. The mock and plain-http local addresses
 * are for development builds only. A demo build is the exception: it runs on the mock on
 * purpose, takes no API URL, and every screen says it is a demo.
 */
export function readEnv(
  source: Readonly<Record<string, string | undefined>>,
  development: boolean,
): AppEnv {
  const apiUrl = source.EXPO_PUBLIC_API_URL?.trim() || undefined;
  const requested = source.EXPO_PUBLIC_API_MODE;
  const demo = source.EXPO_PUBLIC_DEMO === '1';
  if (demo && apiUrl) {
    throw new Error('A demo build runs on sample data and takes no EXPO_PUBLIC_API_URL');
  }
  const apiMode: ApiMode = demo || requested === 'mock' || !apiUrl ? 'mock' : 'http';
  if (!development && apiMode === 'mock' && !demo) {
    throw new Error('A release build needs EXPO_PUBLIC_API_URL and cannot use the mock API');
  }
  if (apiUrl && apiMode === 'http' && !/^https:\/\//.test(apiUrl)) {
    if (!development || !isLocal(apiUrl)) {
      throw new Error('EXPO_PUBLIC_API_URL must use https outside a developer machine');
    }
  }
  const marketId = source.EXPO_PUBLIC_MARKET_ID?.trim() || undefined;
  if (marketId && !/^[A-Z]{2,8}$/.test(marketId)) {
    throw new Error('EXPO_PUBLIC_MARKET_ID must be a Market code');
  }
  if (apiMode === 'http' && !marketId) {
    throw new Error('EXPO_PUBLIC_MARKET_ID is needed with EXPO_PUBLIC_API_URL');
  }
  return { apiMode, apiUrl, marketId, demo };
}

function isLocal(url: string): boolean {
  return /^http:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2|192\.168\.\d+\.\d+)(:\d+)?(\/|$)/.test(url);
}

export const env: AppEnv = readEnv(
  {
    EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL,
    EXPO_PUBLIC_API_MODE: process.env.EXPO_PUBLIC_API_MODE,
    EXPO_PUBLIC_MARKET_ID: process.env.EXPO_PUBLIC_MARKET_ID,
    EXPO_PUBLIC_DEMO: process.env.EXPO_PUBLIC_DEMO,
  },
  __DEV__,
);
