// The only entry point other code may import from this module (marketplace ADR-0008 decision 6).
export { FleetModule } from './fleet.module';
// For dispatch (work package 07): who can take a job now, and the events of the courier pool.
export { FleetDirectory } from './application/use-cases/find-eligible-couriers.use-case';
export type {
  AvailableFleetCourier,
  AvailableFleetVehicle,
  EligibleCourierQuery,
  PayeeProfile,
} from './application/use-cases/find-eligible-couriers.use-case';
export { MAX_PAYEE_PROFILES } from './application/use-cases/find-eligible-couriers.use-case';
export { courierSuspended, courierWentOffline, courierWentOnline } from './domain/events';
