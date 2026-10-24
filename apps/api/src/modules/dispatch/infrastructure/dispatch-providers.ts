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
import { FleetDirectory } from '../../fleet';
import { CourierPositions } from '../../tracking';
import { ConfigDispatchSettingsProvider } from './config-dispatch-settings.provider';
import { FleetCourierAvailability } from './fleet-courier-availability';
import { PrismaDispatchJobRepository } from './prisma-dispatch-job.repository';
import { TrackingCourierProximity } from './tracking-courier-proximity';
import { UnlinkedDelivery } from './unlinked-delivery';

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
  {
    provide: COURIER_AVAILABILITY,
    inject: [FleetDirectory, MarketRegistry],
    useFactory: (fleet: FleetDirectory, markets: MarketRegistry) =>
      new FleetCourierAvailability(fleet, markets),
  },
  {
    provide: COURIER_PROXIMITY,
    inject: [CourierPositions],
    useFactory: (positions: CourierPositions) => new TrackingCourierProximity(positions),
  },
  { provide: DELIVERY_LINK, useValue: new UnlinkedDelivery() },
];
