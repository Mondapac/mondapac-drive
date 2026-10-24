import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertObjectKey, ObjectStoreUnavailableError, type ObjectStore } from './object-store';

/**
 * The local object store: one file per key under a root directory. It is the stand-in for the
 * demo and for tests; an S3-compatible adapter replaces it behind the same port. A write goes
 * to a temporary name and is renamed, so a reader never sees half an object.
 */
export class DiskObjectStore implements ObjectStore {
  constructor(private readonly root: string) {}

  #pathOf(key: string): string {
    assertObjectKey(key);
    return path.join(this.root, ...key.split('/'));
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    const target = this.#pathOf(key);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(temporary, bytes, { flag: 'wx' });
      await rename(temporary, target);
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new ObjectStoreUnavailableError();
    }
  }

  async get(key: string): Promise<Buffer | null> {
    const target = this.#pathOf(key);
    try {
      return await readFile(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new ObjectStoreUnavailableError();
    }
  }

  async delete(key: string): Promise<void> {
    const target = this.#pathOf(key);
    try {
      await rm(target, { force: true });
    } catch {
      throw new ObjectStoreUnavailableError();
    }
  }
}

/** Used when `OBJECT_STORE_DIR` is not set: every call says storage is unavailable. */
export class UnconfiguredObjectStore implements ObjectStore {
  put(): Promise<void> {
    return Promise.reject(new ObjectStoreUnavailableError());
  }
  get(): Promise<Buffer | null> {
    return Promise.reject(new ObjectStoreUnavailableError());
  }
  delete(): Promise<void> {
    return Promise.reject(new ObjectStoreUnavailableError());
  }
}

/** Test double: objects kept in memory. */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Buffer>();
  put(key: string, bytes: Buffer): Promise<void> {
    assertObjectKey(key);
    this.objects.set(key, Buffer.from(bytes));
    return Promise.resolve();
  }
  get(key: string): Promise<Buffer | null> {
    assertObjectKey(key);
    return Promise.resolve(this.objects.get(key) ?? null);
  }
  delete(key: string): Promise<void> {
    assertObjectKey(key);
    this.objects.delete(key);
    return Promise.resolve();
  }
}
