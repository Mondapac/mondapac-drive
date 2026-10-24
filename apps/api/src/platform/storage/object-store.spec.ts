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

  it('lists the objects under a prefix in key order, up to the limit', async () => {
    const { store } = await fresh();
    await store.put('fleet/AU/c1/d2', Buffer.from('2'));
    await store.put('fleet/AU/c1/d1', Buffer.from('1'));
    await store.put('fleet/AU/c2/d3', Buffer.from('3'));
    await store.put('fleet/ZZ/c9/d9', Buffer.from('9'));
    const listed = await store.list('fleet/AU', 10);
    expect(listed.map((o) => o.key)).toEqual([
      'fleet/AU/c1/d1',
      'fleet/AU/c1/d2',
      'fleet/AU/c2/d3',
    ]);
    expect(listed.every((o) => o.writtenAt.epochMilliseconds > 0)).toBe(true);
    expect((await store.list('fleet/AU', 2)).map((o) => o.key)).toEqual([
      'fleet/AU/c1/d1',
      'fleet/AU/c1/d2',
    ]);
    expect((await store.list('fleet/AU', 10, 'fleet/AU/c1/d2')).map((o) => o.key)).toEqual([
      'fleet/AU/c2/d3',
    ]);
    expect(await store.list('fleet/NOPE', 10)).toEqual([]);
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
