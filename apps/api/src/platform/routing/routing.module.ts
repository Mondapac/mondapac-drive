import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import type { Clock, MarketId } from '@mondapac-drive/shared-kernel';
import { Redis } from 'ioredis';
import { CLOCK } from '../clock/clock.module';
import type { AppConfig } from '../config/app-config';
import { APP_CONFIG } from '../config/config.module';
import { MarketRegistry } from '../market-config/market-registry';
import { GoogleRoutesClient } from './google-routes-client';
import { ResilientRoutingProvider, type MarketRouting } from './resilient-routing-provider';
import { InMemoryRouteCache, RedisRouteCache, type RouteCache } from './route-cache';
import { DEFAULT_ROUTING_CONFIG } from './routing-config';
import { ROUTING_PROVIDER } from './routing-provider';

/** How long one Redis command may take before the cache counts as unavailable. */
const REDIS_COMMAND_TIMEOUT_MS = 250;

/**
 * Builds each hosted Market's routing from its `routing` section. A Market configured for Google
 * whose key variable is unset or empty routes by straight line, with a warning at start-up: the
 * quote still works, it is an estimate. The key is read from `env` here and nowhere else.
 */
export function marketRoutingFor(
  markets: MarketRegistry,
  env: Record<string, string | undefined>,
  logger: Pick<Logger, 'warn'> = new Logger('Routing'),
): ReadonlyMap<MarketId, MarketRouting> {
  const result = new Map<MarketId, MarketRouting>();
  for (const marketId of markets.hostedMarketIds()) {
    const market = markets.get(marketId);
    const config = market.routing ?? DEFAULT_ROUTING_CONFIG;
    let road: GoogleRoutesClient | undefined;
    if (config.provider === 'google' && config.google !== undefined) {
      const apiKey = env[config.google.apiKeyEnv];
      if (apiKey === undefined || apiKey.trim() === '') {
        logger.warn({
          msg: 'routing key unset: straight-line estimates only',
          marketId,
          code: 'routing.key-missing',
          variable: config.google.apiKeyEnv,
        });
      } else {
        road = new GoogleRoutesClient({
          apiKey: apiKey.trim(),
          google: config.google,
          languageCode: market.defaultLocale,
          timeoutMs: config.timeoutMs,
        });
      }
    }
    result.set(marketId, { config, road });
  }
  return result;
}

/** Redis when `REDIS_URL` is set, else a cache of this process. */
export function routeCacheFor(config: AppConfig, clock: Clock): RouteCache {
  if (config.redisUrl === null) return new InMemoryRouteCache(clock);
  const redis = new Redis(config.redisUrl, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
  });
  // One warning per outage, without the URL (it may hold a password); ioredis reconnects.
  const logger = new Logger('Routing');
  let down = false;
  redis.on('error', () => {
    if (down) return;
    down = true;
    logger.warn({ msg: 'route cache unavailable', code: 'routing.cache-unreachable' });
  });
  redis.on('ready', () => {
    down = false;
  });
  return new RedisRouteCache(redis);
}

/** Global: exports the port's token only. */
@Global()
@Module({
  providers: [
    {
      provide: ROUTING_PROVIDER,
      inject: [APP_CONFIG, MarketRegistry, CLOCK],
      useFactory: (config: AppConfig, markets: MarketRegistry, clock: Clock) =>
        new ResilientRoutingProvider(
          marketRoutingFor(markets, process.env),
          routeCacheFor(config, clock),
          clock,
        ),
    },
  ],
  exports: [ROUTING_PROVIDER],
})
export class RoutingModule implements OnApplicationShutdown {
  constructor(@Inject(ROUTING_PROVIDER) private readonly routing: ResilientRoutingProvider) {}

  async onApplicationShutdown(): Promise<void> {
    await this.routing.close();
  }
}
