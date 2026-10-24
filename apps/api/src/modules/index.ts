// Bounded-context modules of the core (marketplace ADR-0008 decision 3), each imported through
// its public entry point only.
import { DeliveryModule } from './delivery';
import { DispatchModule } from './dispatch';
import { FleetModule } from './fleet';
import { IdentityModule } from './identity';
import { NotificationsModule } from './notifications';
import { PayoutsModule } from './payouts';
import { TrackingModule } from './tracking';

export const CORE_MODULES = [
  IdentityModule,
  DeliveryModule,
  DispatchModule,
  NotificationsModule,
  FleetModule,
  PayoutsModule,
  TrackingModule,
];
