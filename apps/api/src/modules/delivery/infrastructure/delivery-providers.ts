import type { Provider } from '@nestjs/common';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { ServiceAreaDirectory } from '../../../platform/market-config/service-area-directory';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import { ROUTING_PROVIDER, type RoutingProvider } from '../../../platform/routing';
import {
  DELIVERY_REPOSITORY,
  DISTANCE_PROVIDER,
  GEOCODER,
  MARKET_SETTINGS,
} from '../application/ports';
import { ConfigMarketSettingsProvider } from './config-market-settings.provider';
import { PrismaDeliveryRepository } from './prisma-delivery.repository';
import { RoutingDistanceProvider, RoutingGeocoder } from './routing-delivery.providers';

/** The implementations of the delivery ports. Only infrastructure/ reaches the persistence internals. */
export const deliveryProviders: Provider[] = [
  {
    provide: DELIVERY_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService) => new PrismaDeliveryRepository(prisma),
  },
  {
    provide: MARKET_SETTINGS,
    inject: [MarketRegistry, ServiceAreaDirectory],
    useFactory: (markets: MarketRegistry, areas: ServiceAreaDirectory) =>
      new ConfigMarketSettingsProvider(markets, areas),
  },
  {
    provide: DISTANCE_PROVIDER,
    inject: [ROUTING_PROVIDER],
    useFactory: (routing: RoutingProvider) => new RoutingDistanceProvider(routing),
  },
  {
    provide: GEOCODER,
    inject: [ROUTING_PROVIDER],
    useFactory: (routing: RoutingProvider) => new RoutingGeocoder(routing),
  },
];
