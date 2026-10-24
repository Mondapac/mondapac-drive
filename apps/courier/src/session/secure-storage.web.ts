/**
 * Web is a developer preview of the screens only, and the browser has no keystore: the session
 * is kept in memory and is gone on reload. It is never written to localStorage.
 */
const memory = new Map<string, string>();

export const secureStorage = {
  get: (key: string) => Promise.resolve(memory.get(key) ?? null),
  set: (key: string, value: string) => {
    memory.set(key, value);
    return Promise.resolve();
  },
  remove: (key: string) => {
    memory.delete(key);
    return Promise.resolve();
  },
};
