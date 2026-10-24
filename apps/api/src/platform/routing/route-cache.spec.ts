import { geoPoint, parseMarketId, Temporal } from '@mondapac-drive/shared-kernel';
import { FixedClock } from '@mondapac-drive/shared-kernel/testing';
import { Redis } from 'ioredis';
import {
  decodeCachedRoute,
  InMemoryRouteCache,
  RedisRouteCache,
  ROUTE_CACHE_PREFIX,
  routeCacheKey,
  type RedisCommands,
} from './route-cache';

const AU = parseMarketId('AU');
const ZZ = parseMarketId('ZZ');
if (!AU.ok || !ZZ.ok) throw new Error('market ids');

describe('routeCacheKey', () => {
  const a = geoPoint(-27.46981, 153.02512);
  const b = geoPoint(-27.481, 153.02);

  it('rounds coordinates, so nearby points share a key', () => {
    const near = geoPoint(-27.46984, 153.02514);
    expect(routeCacheKey(AU.value, a, b, 'car', 4, 'secret')).toBe(
      routeCacheKey(AU.value, near, b, 'car', 4, 'secret'),
    );
    expect(routeCacheKey(AU.value, a, b, 'car', 5, 'secret')).not.toBe(
      routeCacheKey(AU.value, near, b, 'car', 5, 'secret'),
    );
  });

  it('separates Markets, vehicles and directions', () => {
    const key = routeCacheKey(AU.value, a, b, 'car', 4, 'secret');
    expect(routeCacheKey(ZZ.value, a, b, 'car', 4, 'secret')).not.toBe(key);
    expect(routeCacheKey(AU.value, a, b, 'van', 4, 'secret')).not.toBe(key);
    expect(routeCacheKey(AU.value, b, a, 'car', 4, 'secret')).not.toBe(key);
  });

  it('depends on the secret, so it cannot be brute-forced without it', () => {
    expect(routeCacheKey(AU.value, a, b, 'car', 4, 'other')).not.toBe(
      routeCacheKey(AU.value, a, b, 'car', 4, 'secret'),
    );
  });

  it('holds no readable coordinate', () => {
    const key = routeCacheKey(AU.value, a, b, 'car', 4, 'secret');
    expect(key.startsWith(`${ROUTE_CACHE_PREFIX}AU:`)).toBe(true);
    expect(key).not.toContain('27.4');
    expect(key).not.toContain('153');
  });
});

describe('decodeCachedRoute', () => {
  it.each([
    null,
    '',
    'not json',
    '[]',
    '{"distanceMetres":-1,"durationSeconds":2}',
    '{"distanceMetres":1}',
    '{"distanceMetres":2000001,"durationSeconds":2}',
    '{"distanceMetres":1,"durationSeconds":172801}',
  ])('treats %j as a miss', (raw) => expect(decodeCachedRoute(raw)).toBeUndefined());
});

describe('InMemoryRouteCache', () => {
  it('expires entries after their TTL and keeps at most maxEntries', async () => {
    const clock = new FixedClock(Temporal.Instant.from('2026-10-24T00:00:00Z'));
    const cache = new InMemoryRouteCache(clock, 2);
    const route = { distanceMetres: 10, durationSeconds: 2 };
    await cache.set('a', route, 60);
    await cache.set('b', route, 60);
    await cache.set('c', route, 60);
    await expect(cache.get('a')).resolves.toBeUndefined();
    await expect(cache.get('c')).resolves.toEqual(route);
    clock.advance(Temporal.Duration.from({ seconds: 60 }));
    await expect(cache.get('c')).resolves.toBeUndefined();
  });
});

describe('RedisRouteCache', () => {
  it('stores JSON with an expiry and reads it back', async () => {
    const store = new Map<string, string>();
    const calls: unknown[][] = [];
    const fake: RedisCommands = {
      get: (key) => Promise.resolve(store.get(key) ?? null),
      set: (key, value, mode, seconds) => {
        calls.push([key, mode, seconds]);
        store.set(key, value);
        return Promise.resolve('OK');
      },
      quit: () => Promise.resolve('OK'),
    };
    const cache = new RedisRouteCache(fake);
    await cache.set('routing:route:v1:AU:x', { distanceMetres: 5, durationSeconds: 1 }, 900);
    expect(calls).toEqual([['routing:route:v1:AU:x', 'EX', 900]]);
    await expect(cache.get('routing:route:v1:AU:x')).resolves.toEqual({
      distanceMetres: 5,
      durationSeconds: 1,
    });
  });

  // Against a real Redis when REDIS_URL is set (CI's Redis service; locally `docker compose up`).
  const redisUrl = process.env.REDIS_URL;
  (redisUrl === undefined ? it.skip : it)(
    'round-trips through a real Redis with a TTL',
    async () => {
      const redis = new Redis(redisUrl!, { maxRetriesPerRequest: 1 });
      const cache = new RedisRouteCache(redis);
      const key = `${ROUTE_CACHE_PREFIX}ZZ:spec-${process.pid}`;
      try {
        await cache.set(key, { distanceMetres: 7, durationSeconds: 3 }, 30);
        await expect(cache.get(key)).resolves.toEqual({ distanceMetres: 7, durationSeconds: 3 });
        const ttl = await redis.ttl(key);
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(30);
        await redis.del(key);
      } finally {
        await cache.close();
      }
    },
  );
});
