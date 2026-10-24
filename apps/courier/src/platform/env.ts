/**
 * Build-time settings (EXPO_PUBLIC_*, inlined by the Expo bundler). Without an API URL the app
 * runs on the mock adapter, so it works before the backend routes exist.
 */
export type ApiMode = 'mock' | 'http';

export interface AppEnv {
  readonly apiMode: ApiMode;
  readonly apiUrl: string | undefined;
}

/**
 * A release build refuses to start without an https API: the mock would accept every
 * delivery locally and nothing would reach the server. The mock and plain-http local addresses
 * are for development builds only.
 */
export function readEnv(
  source: Readonly<Record<string, string | undefined>>,
  development: boolean,
): AppEnv {
  const apiUrl = source.EXPO_PUBLIC_API_URL?.trim() || undefined;
  const requested = source.EXPO_PUBLIC_API_MODE;
  const apiMode: ApiMode = requested === 'mock' || !apiUrl ? 'mock' : 'http';
  if (!development && apiMode === 'mock') {
    throw new Error('A release build needs EXPO_PUBLIC_API_URL and cannot use the mock API');
  }
  if (apiUrl && apiMode === 'http' && !/^https:\/\//.test(apiUrl)) {
    if (!development || !isLocal(apiUrl)) {
      throw new Error('EXPO_PUBLIC_API_URL must use https outside a developer machine');
    }
  }
  return { apiMode, apiUrl };
}

function isLocal(url: string): boolean {
  return /^http:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2|192\.168\.\d+\.\d+)(:\d+)?(\/|$)/.test(url);
}

export const env: AppEnv = readEnv(
  {
    EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL,
    EXPO_PUBLIC_API_MODE: process.env.EXPO_PUBLIC_API_MODE,
  },
  __DEV__,
);
