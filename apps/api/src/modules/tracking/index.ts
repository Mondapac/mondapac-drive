// The only entry point other code may import from this module (marketplace ADR-0008 decision 6).
// Dispatch (07) and panels inject NearestCouriers and LastKnownPosition; delivery and dispatch
// report progress with TrackDelivery; notifications issue customer links with IssueTrackingLink.
export { TrackingModule } from './tracking.module';
export { NearestCouriers } from './application/use-cases/nearest-couriers.use-case';
export type { NearestCouriersOptions } from './application/use-cases/nearest-couriers.use-case';
export { LastKnownPosition } from './application/use-cases/last-known-position.use-case';
export { TrackDelivery } from './application/use-cases/track-delivery.use-case';
export type { TrackDeliveryInput } from './application/use-cases/track-delivery.use-case';
export { IssueTrackingLink } from './application/use-cases/issue-tracking-link.use-case';
export type { IssuedTrackingLink } from './application/use-cases/issue-tracking-link.use-case';
export { RecordLocationPing } from './application/use-cases/record-location-ping.use-case';
export type { LocationPingInput } from './application/use-cases/record-location-ping.use-case';
export type { LivePosition, NearbyCourier } from './domain/live-position';
