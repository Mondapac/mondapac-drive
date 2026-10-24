// Bounded-context modules of the core (marketplace ADR-0008 decision 3), each imported through
// its public entry point only.
import { DeliveryModule } from './delivery';
import { IdentityModule } from './identity';

export const CORE_MODULES = [IdentityModule, DeliveryModule];
