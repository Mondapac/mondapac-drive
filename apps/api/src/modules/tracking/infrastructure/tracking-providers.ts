import type { Provider } from '@nestjs/common';
import type { Clock } from '@mondapac-drive/shared-kernel';
import { Redis } from 'ioredis';
import { CLOCK } from '../../../platform/clock/clock.module';
import type { AppConfig } from '../../../platform/config/app-config';
import { APP_CONFIG } from '../../../platform/config/config.module';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import { ROUTING_PROVIDER, type RoutingProvider } from '../../../platform/routing';
import {
  ETA_PROVIDER,
  LIVE_POSITION_STORE,
  TRACKING_REPOSITORY,
  TRACKING_SETTINGS,
  TRACKING_TOKENS,
  type TrackingSettingsProvider,
} from '../application/ports';
import { ConfigTrackingSettingsProvider } from './config-tracking-settings.provider';
import { CryptoTrackingTokens } from './crypto-tracking-tokens';
import { InMemoryLivePositionStore } from './in-memory-live-position-store';
import { PrismaTrackingRepository } from './prisma-tracking.repository';
import { RedisLivePositionStore } from './redis-live-position-store';
import { RoutingEtaProvider } from './routing-eta.provider';

/** Refused at boot: live positions in one process would differ per API instance. */
export class TrackingStoreConfigError extends Error {
  override readonly name = 'TrackingStoreConfigError';
}

/** The live position store: Redis when `REDIS_URL` is set, else this process (never in production). */
export function livePositionStoreFor(config: AppConfig, clock: Clock) {
  if (config.redisUrl !== null) {
    // Connects on the first command; a Redis outage fails that command, never the process.
    return new RedisLivePositionStore(
      new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 }),
    );
  }
  if (config.nodeEnv === 'production') {
    throw new TrackingStoreConfigError('REDIS_URL is required in production (live positions)');
  }
  return new InMemoryLivePositionStore(clock);
}

/** The implementations of the tracking ports. Only infrastructure/ reaches Redis and Prisma. */
export const trackingProviders: Provider[] = [
  {
    provide: TRACKING_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService) => new PrismaTrackingRepository(prisma),
  },
  {
    provide: TRACKING_SETTINGS,
    inject: [MarketRegistry],
    useFactory: (markets: MarketRegistry) => new ConfigTrackingSettingsProvider(markets),
  },
  {
    provide: LIVE_POSITION_STORE,
    inject: [APP_CONFIG, CLOCK],
    useFactory: livePositionStoreFor,
  },
  {
    provide: ETA_PROVIDER,
    inject: [ROUTING_PROVIDER, TRACKING_SETTINGS, CLOCK],
    useFactory: (routing: RoutingProvider, settings: TrackingSettingsProvider, clock: Clock) =>
      new RoutingEtaProvider(routing, settings, clock),
  },
  { provide: TRACKING_TOKENS, useValue: new CryptoTrackingTokens() },
];
