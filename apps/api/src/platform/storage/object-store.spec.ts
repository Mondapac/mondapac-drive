import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DiskObjectStore } from './disk-object-store';
import { isValidObjectKey } from './object-store';

describe('object keys', () => {
  it.each(['a', 'p1/img-2/medium', 'AU/0198/x_y-z'])('accepts %s', (key) => {
    expect(isValidObjectKey(key)).toBe(true);
  });
  it.each(['', '/a', 'a/', 'a//b', '../a', 'a/../b', 'a/b.jpg', 'a b', '-a', 'a/b/c/d/e/f/g'])(
    'refuses %p',
    (key) => {
      expect(isValidObjectKey(key)).toBe(false);
    },
  );
});

describe('DiskObjectStore', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  const fresh = async (): Promise<{ store: DiskObjectStore; dir: string }> => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'store-'));
    dirs.push(dir);
    return { store: new DiskObjectStore(dir), dir };
  };

  it('writes, reads and deletes an object', async () => {
    const { store } = await fresh();
    await store.put('p1/i1/thumb', Buffer.from('abc'));
    expect((await store.get('p1/i1/thumb'))?.toString()).toBe('abc');
    await store.delete('p1/i1/thumb');
    expect(await store.get('p1/i1/thumb')).toBeNull();
    await expect(store.delete('p1/i1/thumb')).resolves.toBeUndefined();
  });

  it('leaves no temporary file behind', async () => {
    const { store, dir } = await fresh();
    await store.put('p1/i1/thumb', Buffer.from('abc'));
    expect(await readdir(path.join(dir, 'p1', 'i1'))).toEqual(['thumb']);
  });

  it('refuses a key that could leave the root', async () => {
    const { store } = await fresh();
    await expect(store.get('../etc/passwd')).rejects.toThrow('invalid object key');
    await expect(store.put('a/../../x', Buffer.from('x'))).rejects.toThrow('invalid object key');
  });
});
