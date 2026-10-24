// Bounded-context modules of the core (marketplace ADR-0008 decision 3), each imported through
// its public entry point only.
import { DeliveryModule } from './delivery';
import { DispatchModule } from './dispatch';
import { NotificationsModule } from './notifications';

export const CORE_MODULES = [DeliveryModule, DispatchModule, NotificationsModule];
