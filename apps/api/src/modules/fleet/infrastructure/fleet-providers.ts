import type { Provider } from '@nestjs/common';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { ServiceAreaDirectory } from '../../../platform/market-config/service-area-directory';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import { COURIER_REPOSITORY, FLEET_RULES } from '../application/ports';
import { ConfigFleetRulesProvider } from './config-fleet-rules.provider';
import { PrismaCourierRepository } from './prisma-courier.repository';

/** The implementations of the fleet ports. Only infrastructure/ reaches the persistence internals. */
export const fleetProviders: Provider[] = [
  {
    provide: COURIER_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService) => new PrismaCourierRepository(prisma),
  },
  {
    provide: FLEET_RULES,
    inject: [MarketRegistry, ServiceAreaDirectory],
    useFactory: (markets: MarketRegistry, areas: ServiceAreaDirectory) =>
      new ConfigFleetRulesProvider(markets, areas),
  },
];
