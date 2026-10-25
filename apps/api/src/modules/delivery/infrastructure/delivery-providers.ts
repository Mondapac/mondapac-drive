import type { Provider } from '@nestjs/common';
import type { Clock } from '@mondapac-drive/shared-kernel';
import { CLOCK } from '../../../platform/clock/clock.module';
import { APP_CONFIG } from '../../../platform/config/config.module';
import type { AppConfig } from '../../../platform/config/app-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { ServiceAreaDirectory } from '../../../platform/market-config/service-area-directory';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import { IDENTITY_FACADE, type IdentityFacade } from '../../identity';
import { ROUTING_PROVIDER, type RoutingProvider } from '../../../platform/routing';
import {
  COURIER_ACCOUNTS,
  DELIVERY_REPOSITORY,
  DISTANCE_PROVIDER,
  GEOCODER,
  MARKET_SETTINGS,
  PROOF_PHOTOS,
  RECIPIENT_PINS,
  type MarketSettingsProvider,
} from '../application/ports';
import { HmacRecipientPins, pinKey } from './hmac-recipient-pins';
import { PrismaProofPhotoRepository } from './prisma-proof-photo.repository';
import { ConfigMarketSettingsProvider } from './config-market-settings.provider';
import { IdentityCourierAccounts } from './identity-courier-accounts';
import { PrismaDeliveryRepository } from './prisma-delivery.repository';
import {
  CachingGeocoder,
  RoutingDistanceProvider,
  RoutingGeocoder,
} from './routing-delivery.providers';

/** The implementations of the delivery ports. Only infrastructure/ reaches the persistence internals. */
export const deliveryProviders: Provider[] = [
  {
    provide: DELIVERY_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService) => new PrismaDeliveryRepository(prisma),
  },
  {
    provide: PROOF_PHOTOS,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService) => new PrismaProofPhotoRepository(prisma),
  },
  {
    provide: RECIPIENT_PINS,
    inject: [APP_CONFIG],
    useFactory: (config: AppConfig) => new HmacRecipientPins(pinKey(process.env, config)),
  },
  {
    provide: MARKET_SETTINGS,
    inject: [MarketRegistry, ServiceAreaDirectory],
    useFactory: (markets: MarketRegistry, areas: ServiceAreaDirectory) =>
      new ConfigMarketSettingsProvider(markets, areas),
  },
  {
    provide: DISTANCE_PROVIDER,
    inject: [ROUTING_PROVIDER, MARKET_SETTINGS],
    useFactory: (routing: RoutingProvider, markets: MarketSettingsProvider) =>
      new RoutingDistanceProvider(routing, markets),
  },
  {
    provide: COURIER_ACCOUNTS,
    inject: [IDENTITY_FACADE],
    useFactory: (identity: IdentityFacade) => new IdentityCourierAccounts(identity),
  },
  {
    provide: GEOCODER,
    inject: [ROUTING_PROVIDER, MARKET_SETTINGS, CLOCK],
    useFactory: (routing: RoutingProvider, markets: MarketSettingsProvider, clock: Clock) =>
      new CachingGeocoder(new RoutingGeocoder(routing), markets, clock),
  },
];
