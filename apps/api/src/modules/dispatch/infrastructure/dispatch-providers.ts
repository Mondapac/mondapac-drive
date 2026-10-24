import type { Provider } from '@nestjs/common';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import {
  COURIER_AVAILABILITY,
  COURIER_PROXIMITY,
  DELIVERY_LINK,
  DISPATCH_JOB_REPOSITORY,
  DISPATCH_SETTINGS,
} from '../application/ports';
import { ConfigDispatchSettingsProvider } from './config-dispatch-settings.provider';
import { InMemoryCouriers } from './in-memory-couriers';
import { PrismaDispatchJobRepository } from './prisma-dispatch-job.repository';
import { UnlinkedDelivery } from './unlinked-delivery';

/** Until fleet (05) and tracking (06) are on main, one in-memory stand-in answers both ports. */
const couriers = Symbol('InMemoryCouriers');

/** The implementations of the dispatch ports. Only infrastructure/ reaches the persistence internals. */
export const dispatchProviders: Provider[] = [
  {
    provide: DISPATCH_JOB_REPOSITORY,
    inject: [PrismaService],
    useFactory: (prisma: PrismaService) => new PrismaDispatchJobRepository(prisma),
  },
  {
    provide: DISPATCH_SETTINGS,
    inject: [MarketRegistry],
    useFactory: (markets: MarketRegistry) => new ConfigDispatchSettingsProvider(markets),
  },
  { provide: couriers, useFactory: () => new InMemoryCouriers() },
  { provide: COURIER_AVAILABILITY, useExisting: couriers },
  { provide: COURIER_PROXIMITY, useExisting: couriers },
  { provide: DELIVERY_LINK, useValue: new UnlinkedDelivery() },
];
