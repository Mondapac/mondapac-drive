import type { OnApplicationShutdown } from '@nestjs/common';
import type { GeoPoint, MarketContext } from '@mondapac-drive/shared-kernel';
import type { Redis } from 'ioredis';
import type { LivePositionStore } from '../application/ports';
import type { LivePosition, NearbyCourier } from '../domain/live-position';
import { decodePosition, encodePosition } from './live-position-codec';

/**
 * Every key of a Market's tenant shares the hash tag `{<market>:<tenant>}`, so one script can
 * touch them together on a Redis Cluster too, and no tenant ever reads another's couriers:
 * - `tracking:{AU:default}:pos:<courier>`  hash: `at` (epoch ms of the reading) and `json`, with
 *   the TTL
 * - `tracking:{AU:default}:geo`            GEO set of the tenant's couriers
 * - `tracking:{AU:default}:geo:<area>`     GEO set of one service area
 * - `tracking:{AU:default}:slot:<courier>` the ping throttle
 * A GEO member has no TTL of its own: a member whose position key expired, or whose latest ping
 * named another area, is removed when a search meets it. The sets themselves expire when no
 * courier of the Market pings for a whole TTL.
 */
const tag = (market: MarketContext) => `tracking:{${market.marketId}:${market.tenantId}}`;
const positionKey = (market: MarketContext, courierId: string) => `${tag(market)}:pos:${courierId}`;
const geoKey = (market: MarketContext, area?: string) =>
  area === undefined ? `${tag(market)}:geo` : `${tag(market)}:geo:${area}`;
const slotKey = (market: MarketContext, courierId: string) => `${tag(market)}:slot:${courierId}`;

/**
 * Saves the position only when it is later than the stored one, and adds the courier to the
 * Market's GEO set (and the area's, when KEYS[3] is given), all at once.
 * KEYS: position, market set, [area set]. ARGV: at, json, ttl ms, lng, lat, courier.
 */
const SAVE_SCRIPT = `
local current = redis.call('HGET', KEYS[1], 'at')
if current and tonumber(current) >= tonumber(ARGV[1]) then return 0 end
redis.call('HSET', KEYS[1], 'at', ARGV[1], 'json', ARGV[2])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
for i = 2, #KEYS do
  redis.call('GEOADD', KEYS[i], ARGV[4], ARGV[5], ARGV[6])
  redis.call('PEXPIRE', KEYS[i], ARGV[3])
end
return 1
`;

/** How many more GEO members a search reads than it returns, to skip expired ones. */
const OVERFETCH = 2;

/** {@link LivePositionStore} on Redis GEO (ioredis). Never logs a coordinate. */
export class RedisLivePositionStore implements LivePositionStore, OnApplicationShutdown {
  constructor(private readonly redis: Redis) {}

  async claimPingSlot(market: MarketContext, courierId: string, intervalSeconds: number) {
    const claimed = await this.redis.set(
      slotKey(market, courierId),
      '1',
      'EX',
      intervalSeconds,
      'NX',
    );
    return claimed === 'OK';
  }

  async save(market: MarketContext, position: LivePosition, ttlSeconds: number): Promise<boolean> {
    const keys = [positionKey(market, position.courierId), geoKey(market)];
    if (position.serviceAreaCode !== undefined) {
      keys.push(geoKey(market, position.serviceAreaCode));
    }
    const saved = await this.redis.eval(
      SAVE_SCRIPT,
      keys.length,
      ...keys,
      String(position.recordedAt.epochMilliseconds),
      encodePosition(position),
      String(ttlSeconds * 1000),
      String(position.point.lng),
      String(position.point.lat),
      position.courierId,
    );
    return saved === 1;
  }

  async lastKnown(market: MarketContext, courierId: string): Promise<LivePosition | undefined> {
    const json = await this.redis.hget(positionKey(market, courierId), 'json');
    return json === null ? undefined : decodePosition(json);
  }

  async nearest(
    market: MarketContext,
    point: GeoPoint,
    radiusMetres: number,
    limit: number,
    serviceAreaCode?: string,
  ): Promise<NearbyCourier[]> {
    const set = geoKey(market, serviceAreaCode);
    const found = (await this.redis.geosearch(
      set,
      'FROMLONLAT',
      point.lng,
      point.lat,
      'BYRADIUS',
      radiusMetres,
      'm',
      'ASC',
      'COUNT',
      limit * OVERFETCH,
      'WITHDIST',
    )) as [string, string][];
    if (found.length === 0) return [];

    const pipeline = this.redis.pipeline();
    for (const [courierId] of found) pipeline.hget(positionKey(market, courierId), 'json');
    const positions = (await pipeline.exec()) ?? [];

    const nearby: NearbyCourier[] = [];
    const gone: string[] = [];
    found.forEach(([courierId, distance], index) => {
      const [error, json] = positions[index] ?? [null, null];
      if (error !== null || typeof json !== 'string') {
        gone.push(courierId);
        return;
      }
      const position = decodePosition(json);
      if (serviceAreaCode !== undefined && position.serviceAreaCode !== serviceAreaCode) {
        gone.push(courierId);
        return;
      }
      if (nearby.length < limit) {
        nearby.push({ position, distanceMetres: Math.round(Number(distance)) });
      }
    });
    if (gone.length > 0) await this.redis.zrem(set, ...gone);
    return nearby;
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status === 'ready') {
      await this.redis.quit().catch(() => undefined);
    } else {
      this.redis.disconnect();
    }
  }
}
