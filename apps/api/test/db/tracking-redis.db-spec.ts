import { randomBytes } from 'node:crypto';
import { Temporal } from '@mondapac-drive/shared-kernel';
import { Redis } from 'ioredis';
import type { LivePosition } from '../../src/modules/tracking/domain/live-position';
import { RedisLivePositionStore } from '../../src/modules/tracking/infrastructure/redis-live-position-store';
import { TEST_MARKET_IDS } from '../support/test-config';

// The live position store on a real Redis (REDIS_URL; docker compose maps it to 6380, CI sets
// it): GEO search nearest first, a later reading wins, the TTL drops an offline courier, the
// throttle slot, per-area sets, and no Market sees another's couriers. Courier ids are random,
// so parallel runs on one Redis never meet.

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';
const run = randomBytes(4).toString('hex');
const at = Temporal.Instant.from('2026-11-02T00:00:00Z');

describe('live positions on Redis (integration)', () => {
  let redis: Redis;
  let store: RedisLivePositionStore;

  beforeAll(() => {
    redis = new Redis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    store = new RedisLivePositionStore(redis);
  });

  afterAll(async () => {
    const keys = await redis.keys(`tracking:*${run}*`);
    if (keys.length > 0) await redis.del(...keys);
    await store.onApplicationShutdown();
  });

  const position = (
    courier: string,
    lat: number,
    extra: Partial<LivePosition> = {},
  ): LivePosition => ({
    courierId: `${courier}-${run}`,
    point: { lat, lng: 153.02 },
    accuracyMetres: 12,
    headingDegrees: 45,
    recordedAt: at,
    ...extra,
  });
  const ours = (ids: string[]) => ids.filter((id) => id.endsWith(run));

  describe.each(TEST_MARKET_IDS)('in market %s', (market) => {
    const other = TEST_MARKET_IDS.find((m) => m !== market)!;

    it('answers the nearest couriers first, with their positions, and only within the radius', async () => {
      await store.save(market, position('near', -27.4701), 60);
      await store.save(market, position('mid', -27.48), 60);
      await store.save(market, position('far', -27.9), 60);

      const found = await store.nearest(market, { lat: -27.47, lng: 153.02 }, 5000, 50);
      const ids = ours(found.map((n) => n.position.courierId));
      expect(ids).toEqual([`near-${run}`, `mid-${run}`]);
      const near = found.find((n) => n.position.courierId === `near-${run}`)!;
      expect(near.distanceMetres).toBeLessThan(50);
      expect(near.position).toEqual(position('near', -27.4701));

      const elsewhere = await store.nearest(other, { lat: -27.47, lng: 153.02 }, 5000, 50);
      expect(ours(elsewhere.map((n) => n.position.courierId))).not.toContain(`near-${run}`);
    });

    it('keeps the later reading when pings arrive out of order', async () => {
      expect(
        await store.save(
          market,
          position(`order${market}`, -27.47, { recordedAt: at.add({ seconds: 10 }) }),
          60,
        ),
      ).toBe(true);
      expect(
        await store.save(market, position(`order${market}`, -27.6, { recordedAt: at }), 60),
      ).toBe(false);
      expect((await store.lastKnown(market, `order${market}-${run}`))?.point.lat).toBe(-27.47);
      expect(await store.lastKnown(other, `order${market}-${run}`)).toBeUndefined();
    });

    it('drops a courier once the TTL runs out, from the position and from the search', async () => {
      await store.save(market, position('gone', -27.4702), 1);
      expect(await store.lastKnown(market, `gone-${run}`)).toBeDefined();
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(await store.lastKnown(market, `gone-${run}`)).toBeUndefined();
      const found = await store.nearest(market, { lat: -27.47, lng: 153.02 }, 5000, 50);
      expect(found.map((n) => n.position.courierId)).not.toContain(`gone-${run}`);
      // The stale GEO member was removed by the search.
      expect(await redis.zscore(`tracking:{${market}}:geo`, `gone-${run}`)).toBeNull();
    });

    it('searches one service area, and moves a courier out of the area they left', async () => {
      const area = `area-${run}`;
      await store.save(market, position('area', -27.4703, { serviceAreaCode: area }), 60);
      const inArea = await store.nearest(market, { lat: -27.47, lng: 153.02 }, 5000, 50, area);
      expect(inArea.map((n) => n.position.courierId)).toEqual([`area-${run}`]);

      await store.save(
        market,
        position('area', -27.4703, {
          serviceAreaCode: `other-${run}`,
          recordedAt: at.add({ seconds: 5 }),
        }),
        60,
      );
      expect(await store.nearest(market, { lat: -27.47, lng: 153.02 }, 5000, 50, area)).toEqual([]);
    });

    it('gives a courier one ping slot per interval', async () => {
      const courier = `slot-${run}`;
      expect(await store.claimPingSlot(market, courier, 1)).toBe(true);
      expect(await store.claimPingSlot(market, courier, 1)).toBe(false);
      expect(await store.claimPingSlot(other, courier, 1)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      expect(await store.claimPingSlot(market, courier, 1)).toBe(true);
    });

    it('expires every key it writes', async () => {
      await store.save(market, position('ttl', -27.4704), 60);
      for (const key of [`tracking:{${market}}:pos:ttl-${run}`, `tracking:{${market}}:geo`]) {
        const ttl = await redis.pttl(key);
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(60_000);
      }
    });
  });
});
