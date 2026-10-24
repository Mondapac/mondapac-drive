import * as SecureStore from 'expo-secure-store';
import { readEnv } from '../src/platform/env';
import {
  clearSession,
  isOnlineFlagSet,
  loadSession,
  saveSession,
  sessionSource,
  setOnlineFlag,
} from '../src/session/session-store';

const session = {
  token: 'token-0123456789abcdef',
  courierId: 'courier-1',
  marketId: 'ZZ',
  displayName: 'Test',
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
});

describe('build settings', () => {
  const DEV = true;
  const RELEASE = false;

  it('runs on the mock without an API URL in a development build', () => {
    expect(readEnv({}, DEV)).toEqual({ apiMode: 'mock', apiUrl: undefined });
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
    expect(readEnv({ EXPO_PUBLIC_API_URL: 'https://api.example.test' }, RELEASE).apiMode).toBe(
      'http',
    );
  });

  it('allows plain http only to a local address in a development build', () => {
    expect(readEnv({ EXPO_PUBLIC_API_URL: 'http://localhost:3000' }, DEV).apiMode).toBe('http');
    expect(() => readEnv({ EXPO_PUBLIC_API_URL: 'http://localhost:3000' }, RELEASE)).toThrow(
      /https/,
    );
    expect(() => readEnv({ EXPO_PUBLIC_API_URL: 'http://api.example.test' }, DEV)).toThrow(/https/);
  });
});
