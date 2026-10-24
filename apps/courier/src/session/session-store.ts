import type { SessionSource } from '../api/client';
import { courierSession, type CourierSession } from '../api/schemas';
import { secureStorage } from './secure-storage';

/**
 * The session token lives in the platform keystore (Keychain, Android Keystore) through
 * expo-secure-store, never in AsyncStorage or another plain store.
 */
const SESSION_KEY = 'mondapac.courier.session';
/** Whether the courier is online; the background location task reads it before it sends. */
const ONLINE_KEY = 'mondapac.courier.online';

let current: CourierSession | null = null;

/** The session in memory, which the API adapters attach to each call. */
export const sessionSource: SessionSource = { current: () => current };

export async function loadSession(): Promise<CourierSession | null> {
  const stored = await secureStorage.get(SESSION_KEY);
  if (!stored) {
    current = null;
    return null;
  }
  const parsed = courierSession.safeParse(safeJson(stored));
  if (!parsed.success) {
    await clearSession();
    return null;
  }
  current = parsed.data;
  return current;
}

export async function saveSession(session: CourierSession): Promise<void> {
  await secureStorage.set(SESSION_KEY, JSON.stringify(session));
  current = session;
}

export async function clearSession(): Promise<void> {
  current = null;
  await Promise.all([secureStorage.remove(SESSION_KEY), secureStorage.remove(ONLINE_KEY)]);
}

export async function setOnlineFlag(online: boolean): Promise<void> {
  if (online) await secureStorage.set(ONLINE_KEY, '1');
  else await secureStorage.remove(ONLINE_KEY);
}

export async function isOnlineFlagSet(): Promise<boolean> {
  return (await secureStorage.get(ONLINE_KEY)) === '1';
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
