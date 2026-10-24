import * as SecureStore from 'expo-secure-store';
import { readEnv } from '../src/platform/env';
import {
  activeJobMemory,
  clearSession,
  isOnlineFlagSet,
  loadSession,
  saveSession,
  sessionSource,
  setOnlineFlag,
} from '../src/session/session-store';

const session = {
  token: 'token-0123456789abcdef',
  marketId: 'ZZ',
};

describe('session store', () => {
  it('keeps the session in the secure store, device-only', async () => {
    await saveSession(session);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      'mondapac.courier.session',
      JSON.stringify(session),
      { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY },
    );
    expect(sessionSource.current()).toEqual(session);
    await expect(loadSession()).resolves.toEqual(session);
  });

  it('drops a stored session that does not parse', async () => {
    await SecureStore.setItemAsync('mondapac.courier.session', '{"token":1}');
    await expect(loadSession()).resolves.toBeNull();
    await expect(SecureStore.getItemAsync('mondapac.courier.session')).resolves.toBeNull();
  });

  it('clears the session and the online flag on sign-out', async () => {
    await saveSession(session);
    await setOnlineFlag(true);
    await expect(isOnlineFlagSet()).resolves.toBe(true);
    await clearSession();
    expect(sessionSource.current()).toBeNull();
    await expect(isOnlineFlagSet()).resolves.toBe(false);
    await expect(loadSession()).resolves.toBeNull();
  });

  it('keeps the accepted delivery across a restart, and drops it with the session', async () => {
    await saveSession(session);
    await activeJobMemory.remember('d-1');
    await loadSession();
    expect(activeJobMemory.current()).toBe('d-1');
    await clearSession();
    expect(activeJobMemory.current()).toBeNull();
    await expect(SecureStore.getItemAsync('mondapac.courier.active-job')).resolves.toBeNull();
  });

  it('starts a new session without the previous courier’s delivery', async () => {
    await SecureStore.setItemAsync('mondapac.courier.active-job', 'd-left-behind');
    await saveSession(session);
    expect(activeJobMemory.current()).toBeNull();
    await loadSession();
    expect(activeJobMemory.current()).toBeNull();
  });
});

describe('build settings', () => {
  const DEV = true;
  const RELEASE = false;

  it('runs on the mock without an API URL in a development build', () => {
    expect(readEnv({}, DEV)).toEqual({ apiMode: 'mock', apiUrl: undefined, marketId: undefined });
    expect(
      readEnv(
        { EXPO_PUBLIC_API_URL: 'https://api.example.test', EXPO_PUBLIC_API_MODE: 'mock' },
        DEV,
      ).apiMode,
    ).toBe('mock');
  });

  it('refuses the mock in a release build', () => {
    expect(() => readEnv({}, RELEASE)).toThrow(/release build/);
    expect(() =>
      readEnv(
        { EXPO_PUBLIC_API_URL: 'https://api.example.test', EXPO_PUBLIC_API_MODE: 'mock' },
        RELEASE,
      ),
    ).toThrow(/release build/);
    expect(
      readEnv(
        { EXPO_PUBLIC_API_URL: 'https://api.example.test', EXPO_PUBLIC_MARKET_ID: 'ZZ' },
        RELEASE,
      ).apiMode,
    ).toBe('http');
  });

  it('needs the Market code of the build with a real API', () => {
    expect(() => readEnv({ EXPO_PUBLIC_API_URL: 'https://api.example.test' }, DEV)).toThrow(
      /MARKET_ID/,
    );
    expect(() =>
      readEnv(
        { EXPO_PUBLIC_API_URL: 'https://api.example.test', EXPO_PUBLIC_MARKET_ID: 'zz;' },
        DEV,
      ),
    ).toThrow(/Market code/);
  });

  it('allows plain http only to a local address in a development build', () => {
    expect(
      readEnv({ EXPO_PUBLIC_API_URL: 'http://localhost:3000', EXPO_PUBLIC_MARKET_ID: 'ZZ' }, DEV)
        .apiMode,
    ).toBe('http');
    expect(() => readEnv({ EXPO_PUBLIC_API_URL: 'http://localhost:3000' }, RELEASE)).toThrow(
      /https/,
    );
    expect(() => readEnv({ EXPO_PUBLIC_API_URL: 'http://api.example.test' }, DEV)).toThrow(/https/);
  });
});
