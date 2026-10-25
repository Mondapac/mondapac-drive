import { Module } from '@nestjs/common';
import type { Clock, IdGenerator } from '@mondapac-drive/shared-kernel';
import { registerAuditActions } from '../../platform/audit/audit-action-catalogue';
import { AUDIT_WRITER, type AuditWriter } from '../../platform/audit/audit-writer';
import { registerPermissions, USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { registerEvents } from '../../platform/events/event-catalogue';
import { registerSubscriptionsFrom } from '../../platform/events/event-subscriptions';
import { OUTBOX_WRITER, type OutboxWriter } from '../../platform/events/outbox-writer';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { UNIT_OF_WORK, type UnitOfWork } from '../../platform/unit-of-work/unit-of-work';
import { DeliveryModule } from '../delivery';
import { FleetModule } from '../fleet';
import { IdentityModule } from '../identity';
import { PayoutsModule } from '../payouts';
import { TrackingModule } from '../tracking';
import { JobAdvancer } from './application/job-advancer';
import {
  COURIER_ACCOUNTS,
  DELIVERY_FACTS,
  DISPATCH_JOB_REPOSITORY,
  DISPATCH_SETTINGS,
  OFFER_EARNINGS,
  type CourierAccounts,
  type DeliveryFacts,
  type DispatchJobRepository,
  type DispatchSettingsProvider,
  type OfferEarnings,
} from './application/ports';
import { AdvanceDispatchJobs } from './application/use-cases/advance-dispatch-jobs.use-case';
import { AnswerOffer } from './application/use-cases/answer-offer.use-case';
import { AssignCourier } from './application/use-cases/assign-courier.use-case';
import { CancelDispatchJob } from './application/use-cases/cancel-dispatch-job.use-case';
import { FollowDeliveryStatus } from './application/use-cases/follow-delivery-status.use-case';
import { OpenDispatchJob } from './application/use-cases/open-dispatch-job.use-case';
import { RestartOffering } from './application/use-cases/restart-offering.use-case';
import { ViewCurrentOffer } from './application/use-cases/view-current-offer.use-case';
import { ViewDispatchJob } from './application/use-cases/view-dispatch-job.use-case';
import { DISPATCH_PERMISSIONS } from './contracts/permissions';
import { DISPATCH_AUDIT_ACTIONS } from './domain/audit-actions';
import { DISPATCH_EVENTS } from './domain/events/dispatch-events';
import { dispatchProviders } from './infrastructure/dispatch-providers';
import { CourierOffersController, DispatcherController } from './presentation/dispatch.controller';
import { advanceDispatchJobsJob } from './presentation/jobs/advance-dispatch-jobs.job';
import { deliverySubscriptions } from './presentation/subscribers/delivery.subscriptions';

/**
 * Dispatch: finds a courier for each delivery. A job opens from the delivery's booking event;
 * offers go out in waves to the nearest couriers who can carry the parcel, lapse after the
 * Market's accept timeout, and after the last round the job waits for a dispatcher, who may
 * also assign or reassign by hand. Couriers come from fleet (who may take work) and tracking
 * (who is near). Every entry goes through a use case behind the UseCaseGate: a courier sees and
 * answers its own offers, dispatchers view, assign and restart jobs (audited), and the delivery
 * events and the sweep run as the system.
 */
@Module({
  imports: [DeliveryModule, FleetModule, TrackingModule, IdentityModule, PayoutsModule],
  controllers: [CourierOffersController, DispatcherController],
  providers: [
    JobAdvancer,
    ...dispatchProviders,
    registerPermissions('dispatch', DISPATCH_PERMISSIONS),
    registerAuditActions('dispatch', DISPATCH_AUDIT_ACTIONS),
    PersistenceModule.outboxWriterFor('dispatch'),
    PersistenceModule.auditWriterFor('dispatch'),
    registerEvents('dispatch', DISPATCH_EVENTS),
    {
      provide: OpenDispatchJob,
      inject: [
        USE_CASE_GATE,
        DISPATCH_JOB_REPOSITORY,
        DELIVERY_FACTS,
        DISPATCH_SETTINGS,
        UNIT_OF_WORK,
        ID_GENERATOR,
        CLOCK,
        JobAdvancer,
      ],
      useFactory: (
        gate: UseCaseGate,
        jobs: DispatchJobRepository,
        facts: DeliveryFacts,
        settings: DispatchSettingsProvider,
        unitOfWork: UnitOfWork,
        ids: IdGenerator,
        clock: Clock,
        advancer: JobAdvancer,
      ) => new OpenDispatchJob(gate, { jobs, facts, settings, unitOfWork, ids, clock, advancer }),
    },
    {
      provide: AdvanceDispatchJobs,
      inject: [USE_CASE_GATE, DISPATCH_JOB_REPOSITORY, UNIT_OF_WORK, CLOCK, JobAdvancer],
      useFactory: (
        gate: UseCaseGate,
        jobs: DispatchJobRepository,
        unitOfWork: UnitOfWork,
        clock: Clock,
        advancer: JobAdvancer,
      ) => new AdvanceDispatchJobs(gate, { jobs, unitOfWork, clock, advancer }),
    },
    {
      provide: FollowDeliveryStatus,
      inject: [
        USE_CASE_GATE,
        DISPATCH_JOB_REPOSITORY,
        DELIVERY_FACTS,
        OUTBOX_WRITER,
        UNIT_OF_WORK,
        CLOCK,
        JobAdvancer,
      ],
      useFactory: (
        gate: UseCaseGate,
        jobs: DispatchJobRepository,
        facts: DeliveryFacts,
        outbox: OutboxWriter,
        unitOfWork: UnitOfWork,
        clock: Clock,
        advancer: JobAdvancer,
      ) => new FollowDeliveryStatus(gate, { jobs, facts, outbox, unitOfWork, clock, advancer }),
    },
    {
      provide: CancelDispatchJob,
      inject: [USE_CASE_GATE, DISPATCH_JOB_REPOSITORY, OUTBOX_WRITER, UNIT_OF_WORK, CLOCK],
      useFactory: (
        gate: UseCaseGate,
        jobs: DispatchJobRepository,
        outbox: OutboxWriter,
        unitOfWork: UnitOfWork,
        clock: Clock,
      ) => new CancelDispatchJob(gate, { jobs, outbox, unitOfWork, clock }),
    },
    {
      provide: ViewCurrentOffer,
      inject: [USE_CASE_GATE, DISPATCH_JOB_REPOSITORY, OFFER_EARNINGS, UNIT_OF_WORK, CLOCK],
      useFactory: (
        gate: UseCaseGate,
        jobs: DispatchJobRepository,
        earnings: OfferEarnings,
        unitOfWork: UnitOfWork,
        clock: Clock,
      ) => new ViewCurrentOffer(gate, { jobs, earnings, unitOfWork, clock }),
    },
    {
      provide: AnswerOffer,
      inject: [USE_CASE_GATE, DISPATCH_JOB_REPOSITORY, OUTBOX_WRITER, UNIT_OF_WORK, CLOCK],
      useFactory: (
        gate: UseCaseGate,
        jobs: DispatchJobRepository,
        outbox: OutboxWriter,
        unitOfWork: UnitOfWork,
        clock: Clock,
      ) => new AnswerOffer(gate, { jobs, outbox, unitOfWork, clock }),
    },
    {
      provide: ViewDispatchJob,
      inject: [USE_CASE_GATE, DISPATCH_JOB_REPOSITORY, UNIT_OF_WORK],
      useFactory: (gate: UseCaseGate, jobs: DispatchJobRepository, unitOfWork: UnitOfWork) =>
        new ViewDispatchJob(gate, { jobs, unitOfWork }),
    },
    {
      provide: AssignCourier,
      inject: [
        USE_CASE_GATE,
        DISPATCH_JOB_REPOSITORY,
        COURIER_ACCOUNTS,
        OUTBOX_WRITER,
        AUDIT_WRITER,
        UNIT_OF_WORK,
        CLOCK,
      ],
      useFactory: (
        gate: UseCaseGate,
        jobs: DispatchJobRepository,
        couriers: CourierAccounts,
        outbox: OutboxWriter,
        audit: AuditWriter,
        unitOfWork: UnitOfWork,
        clock: Clock,
      ) => new AssignCourier(gate, { jobs, couriers, outbox, audit, unitOfWork, clock }),
    },
    {
      provide: RestartOffering,
      inject: [USE_CASE_GATE, DISPATCH_JOB_REPOSITORY, AUDIT_WRITER, UNIT_OF_WORK, CLOCK],
      useFactory: (
        gate: UseCaseGate,
        jobs: DispatchJobRepository,
        audit: AuditWriter,
        unitOfWork: UnitOfWork,
        clock: Clock,
      ) => new RestartOffering(gate, { jobs, audit, unitOfWork, clock }),
    },
    registerJobsFrom('dispatch', [AdvanceDispatchJobs], (advance: AdvanceDispatchJobs) => [
      advanceDispatchJobsJob(advance),
    ]),
    registerSubscriptionsFrom(
      'dispatch',
      [OpenDispatchJob, FollowDeliveryStatus, CancelDispatchJob],
      deliverySubscriptions,
    ),
  ],
})
export class DispatchModule {}
