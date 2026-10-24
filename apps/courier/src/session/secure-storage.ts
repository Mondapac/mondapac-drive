import * as SecureStore from 'expo-secure-store';

/**
 * The platform keystore (Keychain, Android Keystore) through expo-secure-store. Readable after
 * the first unlock (the background location task runs with the screen locked) and never
 * included in backups or moved to another device.
 */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export const secureStorage = {
  get: (key: string) => SecureStore.getItemAsync(key, OPTIONS),
  set: (key: string, value: string) => SecureStore.setItemAsync(key, value, OPTIONS),
  remove: (key: string) => SecureStore.deleteItemAsync(key, OPTIONS),
};
