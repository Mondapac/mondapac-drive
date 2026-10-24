import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Temporal } from '@mondapac-drive/shared-kernel';
import {
  assertObjectKey,
  isValidObjectKey,
  ObjectStoreUnavailableError,
  type ObjectStore,
  type StoredObject,
} from './object-store';

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

  async list(prefix: string, limit: number, after?: string): Promise<StoredObject[]> {
    const base = this.#pathOf(prefix);
    let names: string[];
    try {
      names = await readdir(base, { recursive: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new ObjectStoreUnavailableError();
    }
    // Temporary names of writes in flight hold a dot, which no key does.
    const keys = names
      .map((name) => `${prefix}/${name.split(path.sep).join('/')}`)
      .filter((key) => isValidObjectKey(key) && (after === undefined || key > after))
      .sort();
    const found: StoredObject[] = [];
    for (const key of keys) {
      if (found.length >= limit) break;
      let info;
      try {
        info = await stat(this.#pathOf(key));
      } catch (error) {
        // Removed since the directory was read.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new ObjectStoreUnavailableError();
      }
      if (!info.isFile()) continue;
      // mtimeMs carries a fraction of a millisecond, which Temporal refuses.
      const writtenAt = Temporal.Instant.fromEpochMilliseconds(Math.floor(info.mtimeMs));
      found.push({ key, writtenAt });
    }
    return found;
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
  list(): Promise<StoredObject[]> {
    return Promise.reject(new ObjectStoreUnavailableError());
  }
}

/** Test double: objects kept in memory, written at the instant `now` answers (epoch by default). */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Buffer>();
  readonly writtenAt = new Map<string, Temporal.Instant>();
  constructor(
    private readonly now: () => Temporal.Instant = () => Temporal.Instant.fromEpochMilliseconds(0),
  ) {}
  put(key: string, bytes: Buffer): Promise<void> {
    assertObjectKey(key);
    this.objects.set(key, Buffer.from(bytes));
    this.writtenAt.set(key, this.now());
    return Promise.resolve();
  }
  get(key: string): Promise<Buffer | null> {
    assertObjectKey(key);
    return Promise.resolve(this.objects.get(key) ?? null);
  }
  delete(key: string): Promise<void> {
    assertObjectKey(key);
    this.objects.delete(key);
    this.writtenAt.delete(key);
    return Promise.resolve();
  }
  list(prefix: string, limit: number, after?: string): Promise<StoredObject[]> {
    assertObjectKey(prefix);
    return Promise.resolve(
      [...this.objects.keys()]
        .filter((key) => key.startsWith(`${prefix}/`) && (after === undefined || key > after))
        .sort()
        .slice(0, limit)
        .map((key) => ({ key, writtenAt: this.writtenAt.get(key)! })),
    );
  }
}
