import { Inject, Injectable } from '@nestjs/common';
import {
  ok,
  type CallContext,
  type Clock,
  type Id,
  type Result,
} from '@mondapac-drive/shared-kernel';
import { CLOCK } from '../../../../platform/clock/clock.module';
import { OUTBOX_WRITER, type OutboxWriter } from '../../../../platform/events/outbox-writer';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { cancelJob } from '../../domain/dispatch-job';
import { refusingBrokenRules, type DispatchFailure } from '../failure';
import { DISPATCH_JOB_REPOSITORY, type DispatchJobRepository } from '../ports';

/** The delivery was cancelled (system): offers still out are withdrawn and the job stops. */
@Injectable()
export class CancelDispatchJob {
  constructor(
    @Inject(DISPATCH_JOB_REPOSITORY) private readonly jobs: DispatchJobRepository,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriter,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  run(
    context: CallContext,
    deliveryId: Id<'Delivery'>,
  ): Promise<Result<{ readonly cancelled: boolean }, DispatchFailure>> {
    const { market } = context;
    return this.unitOfWork.run(market, () =>
      refusingBrokenRules<{ readonly cancelled: boolean }>(async () => {
        const job = await this.jobs.findByDelivery(market, deliveryId);
        if (job === undefined || job.status === 'CANCELLED') return ok({ cancelled: false });
        const change = cancelJob(job, this.clock.now());
        await this.jobs.update(market, change.job);
        if (change.events.length > 0) await this.outbox.append(context, change.events);
        return ok({ cancelled: true });
      }),
    );
  }
}
