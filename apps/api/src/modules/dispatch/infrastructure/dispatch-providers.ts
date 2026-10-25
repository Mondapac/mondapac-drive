import type { Provider } from '@nestjs/common';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PrismaService } from '../../../platform/persistence/prisma.service';
import {
  COURIER_ACCOUNTS,
  COURIER_AVAILABILITY,
  COURIER_PROXIMITY,
  DELIVERY_FACTS,
  DISPATCH_JOB_REPOSITORY,
  DISPATCH_SETTINGS,
  OFFER_EARNINGS,
} from '../application/ports';
import { DeliveryDispatchView } from '../../delivery';
import { FleetDirectory } from '../../fleet';
import { IDENTITY_FACADE, type IdentityFacade } from '../../identity';
import { EarningsQuote } from '../../payouts';
import { CourierPositions } from '../../tracking/contracts/courier-positions.contract';
import { ConfigDispatchSettingsProvider } from './config-dispatch-settings.provider';
import { DeliveryDispatchFacts } from './delivery-dispatch-facts';
import { FleetCourierAvailability } from './fleet-courier-availability';
import { IdentityCourierAccounts } from './identity-courier-accounts';
import { PayoutsOfferEarnings } from './payouts-offer-earnings';
import { PrismaDispatchJobRepository } from './prisma-dispatch-job.repository';
import { TrackingCourierProximity } from './tracking-courier-proximity';

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
  {
    provide: COURIER_ACCOUNTS,
    inject: [IDENTITY_FACADE],
    useFactory: (identity: IdentityFacade) => new IdentityCourierAccounts(identity),
  },
  {
    provide: DELIVERY_FACTS,
    inject: [DeliveryDispatchView],
    useFactory: (view: DeliveryDispatchView) => new DeliveryDispatchFacts(view),
  },
  {
    provide: OFFER_EARNINGS,
    inject: [EarningsQuote],
    useFactory: (quote: EarningsQuote) => new PayoutsOfferEarnings(quote),
  },
];
