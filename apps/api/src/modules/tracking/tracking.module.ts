import { Module } from '@nestjs/common';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { DeliveryTrail } from './application/use-cases/delivery-trail.use-case';
import { IssueTrackingLink } from './application/use-cases/issue-tracking-link.use-case';
import { LastKnownPosition } from './application/use-cases/last-known-position.use-case';
import { NearestCouriers } from './application/use-cases/nearest-couriers.use-case';
import { PurgeTrackingData } from './application/use-cases/purge-tracking-data.use-case';
import { RecordLocationPing } from './application/use-cases/record-location-ping.use-case';
import { TrackDelivery } from './application/use-cases/track-delivery.use-case';
import { ViewTrackingLink } from './application/use-cases/view-tracking-link.use-case';
import { trackingProviders } from './infrastructure/tracking-providers';
import { purgeTrackingDataJob } from './presentation/jobs/purge-tracking-data.job';
import { TrackingLinkController } from './presentation/tracking-link.controller';

/** What other modules may call: dispatch, panels, notifications and the delivery lifecycle. */
const PUBLIC_USE_CASES = [
  NearestCouriers,
  LastKnownPosition,
  TrackDelivery,
  IssueTrackingLink,
  RecordLocationPing,
];

/**
 * Tracking: couriers' live positions (Redis GEO), each delivery's breadcrumb trail while it is
 * carried (PostgreSQL, purged after the Market's retention), customer tracking links and the
 * straight-line ETA. Only the public tracking-link routes are registered;
 * `TrackingOperationsController` (pings, dispatcher map) waits for identity's authentication.
 */
@Module({
  controllers: [TrackingLinkController],
  providers: [
    ...PUBLIC_USE_CASES,
    ViewTrackingLink,
    DeliveryTrail,
    PurgeTrackingData,
    ...trackingProviders,
    registerJobsFrom('tracking', [PurgeTrackingData], (purge: PurgeTrackingData) => [
      purgeTrackingDataJob(purge),
    ]),
  ],
  exports: PUBLIC_USE_CASES,
})
export class TrackingModule {}
