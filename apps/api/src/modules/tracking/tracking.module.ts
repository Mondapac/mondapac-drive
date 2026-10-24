import { Module, type FactoryProvider } from '@nestjs/common';
import type { Clock } from '@mondapac-drive/shared-kernel';
import { registerPermissions, USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { DeliveryModule, DeliveryDispatchView } from '../delivery';
import { IdentityModule } from '../identity';
import { registerSubscriptionsFrom } from '../../platform/events/event-subscriptions';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { UNIT_OF_WORK, type UnitOfWork } from '../../platform/unit-of-work/unit-of-work';
import {
  DELIVERY_ROUTES,
  ETA_PROVIDER,
  LIVE_POSITION_STORE,
  TRACKING_REPOSITORY,
  TRACKING_SETTINGS,
  TRACKING_TOKENS,
  type DeliveryRoutes,
  type EtaProvider,
  type LivePositionStore,
  type TrackingRepository,
  type TrackingSettingsProvider,
  type TrackingTokens,
} from './application/ports';
import type { PositionDependencies } from './application/positions';
import { CourierPositions } from './application/use-cases/courier-positions.use-case';
import { FollowDelivery } from './application/use-cases/follow-delivery.use-case';
import { DeliveryTrail } from './application/use-cases/delivery-trail.use-case';
import { IssueTrackingLink } from './application/use-cases/issue-tracking-link.use-case';
import { PurgeTrackingData } from './application/use-cases/purge-tracking-data.use-case';
import { RecordLocationPing } from './application/use-cases/record-location-ping.use-case';
import { TrackDelivery } from './application/use-cases/track-delivery.use-case';
import {
  ViewCourierPosition,
  ViewNearbyCouriers,
} from './application/use-cases/view-courier-positions.use-case';
import { ViewTrackingLink } from './application/use-cases/view-tracking-link.use-case';
import { TRACKING_PERMISSIONS } from './contracts/permissions';
import { DeliveryDispatchRoutes } from './infrastructure/delivery-routes.adapter';
import { trackingProviders } from './infrastructure/tracking-providers';
import { AdminSessionCheck } from './presentation/admin-session-check';
import { deliveryLifecycleSubscriptions } from './presentation/subscribers/delivery-lifecycle.subscriptions';
import { purgeTrackingDataJob } from './presentation/jobs/purge-tracking-data.job';
import { TrackingLinkController } from './presentation/tracking-link.controller';
import {
  CourierTrackingController,
  DispatcherTrackingController,
} from './presentation/tracking-operations.controller';

/** What other modules may call: dispatch, notifications and the delivery lifecycle. */
const PUBLIC_USE_CASES = [CourierPositions, TrackDelivery, IssueTrackingLink];

/** The provider of a use case over live positions: the gate, the store and the settings. */
function positionUseCase<U>(
  type: new (gate: UseCaseGate, deps: PositionDependencies) => U,
): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, LIVE_POSITION_STORE, TRACKING_SETTINGS],
    useFactory: (
      gate: UseCaseGate,
      positions: LivePositionStore,
      settings: TrackingSettingsProvider,
    ) => new type(gate, { positions, settings }),
  };
}

/**
 * Tracking: couriers' live positions (Redis GEO, per Market and tenant), each delivery's
 * breadcrumb trail while it is carried (PostgreSQL, purged after the Market's retention),
 * customer tracking links and the routing ETA. Every HTTP entry goes through a use case behind
 * the UseCaseGate: the customer's link is anonymous (the token is the credential), a courier
 * sends its own pings, and operators and dispatchers read the live map and trails.
 */
@Module({
  // identity's Authenticator: the dispatcher map re-checks its session on every event (L1).
  // delivery's DeliveryDispatchView: the route of a delivery tracking first hears of.
  imports: [IdentityModule, DeliveryModule],
  controllers: [TrackingLinkController, CourierTrackingController, DispatcherTrackingController],
  providers: [
    registerPermissions('tracking', TRACKING_PERMISSIONS),
    ...trackingProviders,
    AdminSessionCheck,
    {
      provide: CourierPositions,
      inject: [LIVE_POSITION_STORE, TRACKING_SETTINGS],
      useFactory: (positions: LivePositionStore, settings: TrackingSettingsProvider) =>
        new CourierPositions({ positions, settings }),
    },
    positionUseCase(ViewNearbyCouriers),
    positionUseCase(ViewCourierPosition),
    {
      provide: RecordLocationPing,
      inject: [
        USE_CASE_GATE,
        LIVE_POSITION_STORE,
        TRACKING_REPOSITORY,
        TRACKING_SETTINGS,
        UNIT_OF_WORK,
        CLOCK,
      ],
      useFactory: (
        gate: UseCaseGate,
        positions: LivePositionStore,
        tracking: TrackingRepository,
        settings: TrackingSettingsProvider,
        unitOfWork: UnitOfWork,
        clock: Clock,
      ) => new RecordLocationPing(gate, { positions, tracking, settings, unitOfWork, clock }),
    },
    {
      provide: DeliveryTrail,
      inject: [USE_CASE_GATE, TRACKING_REPOSITORY, UNIT_OF_WORK],
      useFactory: (gate: UseCaseGate, tracking: TrackingRepository, unitOfWork: UnitOfWork) =>
        new DeliveryTrail(gate, { tracking, unitOfWork }),
    },
    {
      provide: TrackDelivery,
      inject: [USE_CASE_GATE, TRACKING_REPOSITORY, UNIT_OF_WORK, CLOCK],
      useFactory: (
        gate: UseCaseGate,
        tracking: TrackingRepository,
        unitOfWork: UnitOfWork,
        clock: Clock,
      ) => new TrackDelivery(gate, { tracking, unitOfWork, clock }),
    },
    {
      provide: IssueTrackingLink,
      inject: [
        USE_CASE_GATE,
        TRACKING_REPOSITORY,
        TRACKING_SETTINGS,
        TRACKING_TOKENS,
        UNIT_OF_WORK,
        CLOCK,
      ],
      useFactory: (
        gate: UseCaseGate,
        tracking: TrackingRepository,
        settings: TrackingSettingsProvider,
        tokens: TrackingTokens,
        unitOfWork: UnitOfWork,
        clock: Clock,
      ) => new IssueTrackingLink(gate, { tracking, settings, tokens, unitOfWork, clock }),
    },
    {
      provide: ViewTrackingLink,
      inject: [
        USE_CASE_GATE,
        TRACKING_REPOSITORY,
        TRACKING_TOKENS,
        LIVE_POSITION_STORE,
        ETA_PROVIDER,
        TRACKING_SETTINGS,
        UNIT_OF_WORK,
        CLOCK,
      ],
      useFactory: (
        gate: UseCaseGate,
        tracking: TrackingRepository,
        tokens: TrackingTokens,
        positions: LivePositionStore,
        eta: EtaProvider,
        settings: TrackingSettingsProvider,
        unitOfWork: UnitOfWork,
        clock: Clock,
      ) =>
        new ViewTrackingLink(gate, {
          tracking,
          tokens,
          positions,
          eta,
          settings,
          unitOfWork,
          clock,
        }),
    },
    {
      provide: PurgeTrackingData,
      inject: [USE_CASE_GATE, TRACKING_REPOSITORY, TRACKING_SETTINGS, UNIT_OF_WORK, CLOCK],
      useFactory: (
        gate: UseCaseGate,
        tracking: TrackingRepository,
        settings: TrackingSettingsProvider,
        unitOfWork: UnitOfWork,
        clock: Clock,
      ) => new PurgeTrackingData(gate, { tracking, settings, unitOfWork, clock }),
    },
    {
      provide: DELIVERY_ROUTES,
      inject: [DeliveryDispatchView],
      useFactory: (view: DeliveryDispatchView) => new DeliveryDispatchRoutes(view),
    },
    {
      provide: FollowDelivery,
      inject: [USE_CASE_GATE, TRACKING_REPOSITORY, DELIVERY_ROUTES, UNIT_OF_WORK, CLOCK],
      useFactory: (
        gate: UseCaseGate,
        tracking: TrackingRepository,
        routes: DeliveryRoutes,
        unitOfWork: UnitOfWork,
        clock: Clock,
      ) => new FollowDelivery(gate, { tracking, routes, unitOfWork, clock }),
    },
    registerSubscriptionsFrom('tracking', [FollowDelivery], (follow: FollowDelivery) =>
      deliveryLifecycleSubscriptions(follow),
    ),
    registerJobsFrom('tracking', [PurgeTrackingData], (purge: PurgeTrackingData) => [
      purgeTrackingDataJob(purge),
    ]),
  ],
  exports: PUBLIC_USE_CASES,
})
export class TrackingModule {}
