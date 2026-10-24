/** The port to private object storage (ADR-0029 decision 2, simplified for the first release). */
export const OBJECT_STORE = Symbol('OBJECT_STORE');

/** No object store is configured, or it failed: the caller answers "unavailable". */
export class ObjectStoreUnavailableError extends Error {
  override readonly name = 'ObjectStoreUnavailableError';
  constructor(message = 'object storage is not available') {
    super(message);
  }
}

/**
 * A key is built by code, never taken from a request: `/`-separated segments of letters,
 * digits, `_` and `-`. No dot, no empty segment, so a key can never climb out of its root.
 */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MAX_SEGMENTS = 6;

export function isValidObjectKey(key: string): boolean {
  const segments = key.split('/');
  return segments.length <= MAX_SEGMENTS && segments.every((segment) => SEGMENT.test(segment));
}

export function assertObjectKey(key: string): void {
  if (!isValidObjectKey(key)) throw new Error('invalid object key');
}

export interface ObjectStore {
  /** Writes the bytes under the key, replacing any object there. */
  put(key: string, bytes: Buffer): Promise<void>;
  /** The bytes, or null when the key holds nothing. */
  get(key: string): Promise<Buffer | null>;
  /** Removes the object; a missing key is not an error. */
  delete(key: string): Promise<void>;
}
