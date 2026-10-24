import { Module } from '@nestjs/common';
import { registerEvents } from '../../platform/events/event-catalogue';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { registerJobsFrom } from '../../platform/scheduler/job-registry';
import { FleetModule } from '../fleet';
import { TrackingModule } from '../tracking';
import { JobAdvancer } from './application/job-advancer';
import { AdvanceDispatchJobs } from './application/use-cases/advance-dispatch-jobs.use-case';
import { AnswerOffer } from './application/use-cases/answer-offer.use-case';
import { AssignCourier } from './application/use-cases/assign-courier.use-case';
import { CancelDispatchJob } from './application/use-cases/cancel-dispatch-job.use-case';
import { OpenDispatchJob } from './application/use-cases/open-dispatch-job.use-case';
import { RedispatchDelivery } from './application/use-cases/redispatch-delivery.use-case';
import { DISPATCH_EVENTS } from './domain/events/dispatch-events';
import { dispatchProviders } from './infrastructure/dispatch-providers';
import { advanceDispatchJobsJob } from './presentation/jobs/advance-dispatch-jobs.job';

/**
 * Dispatch: finds a courier for each delivery. Offers go out in waves to the nearest couriers
 * who can carry the parcel, lapse after the Market's accept timeout, and after the last round
 * the job is handed to a dispatcher, who may also assign or reassign by hand. Couriers come
 * from fleet (who may take work) and tracking (who is near). No routes yet:
 * they come with authentication (work package 2).
 */
@Module({
  imports: [FleetModule, TrackingModule],
  providers: [
    JobAdvancer,
    OpenDispatchJob,
    AdvanceDispatchJobs,
    AnswerOffer,
    AssignCourier,
    RedispatchDelivery,
    CancelDispatchJob,
    ...dispatchProviders,
    PersistenceModule.outboxWriterFor('dispatch'),
    registerEvents('dispatch', DISPATCH_EVENTS),
    registerJobsFrom('dispatch', [AdvanceDispatchJobs], (advance: AdvanceDispatchJobs) => [
      advanceDispatchJobsJob(advance),
    ]),
  ],
})
export class DispatchModule {}
