// The only entry point other code may import from this module (marketplace ADR-0008 decision 6).
// Delivery and dispatch report progress with TrackDelivery; notifications issue customer links
// with IssueTrackingLink. Dispatch's ungated CourierPositions is in
// contracts/courier-positions.contract.ts, which only dispatch may import (L2 of 06b).
export { TrackingModule } from './tracking.module';
export { TrackDelivery } from './application/use-cases/track-delivery.use-case';
export type { TrackDeliveryInput } from './application/use-cases/track-delivery.use-case';
export { IssueTrackingLink } from './application/use-cases/issue-tracking-link.use-case';
export type { IssuedTrackingLink } from './application/use-cases/issue-tracking-link.use-case';
export type { NearbyQuery } from './application/use-cases/view-courier-positions.use-case';
export type { LivePosition, NearbyCourier } from './domain/live-position';
