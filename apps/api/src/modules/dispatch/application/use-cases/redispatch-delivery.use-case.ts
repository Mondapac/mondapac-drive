import { Inject, Injectable } from '@nestjs/common';
import {
  err,
  ok,
  type CallContext,
  type Clock,
  type Id,
  type Result,
} from '@mondapac-drive/shared-kernel';
import { CLOCK } from '../../../../platform/clock/clock.module';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { redispatch, type DispatchJob } from '../../domain/dispatch-job';
import { jobNotFound, refusingBrokenRules, type DispatchFailure } from '../failure';
import { JobAdvancer } from '../job-advancer';
import { DISPATCH_JOB_REPOSITORY, type DispatchJobRepository } from '../ports';

/**
 * The assigned courier dropped the delivery (the courier unassigned, or a dispatcher took it
 * away): offering starts again at once without that courier.
 */
@Injectable()
export class RedispatchDelivery {
  constructor(
    @Inject(DISPATCH_JOB_REPOSITORY) private readonly jobs: DispatchJobRepository,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly advancer: JobAdvancer,
  ) {}

  async run(
    context: CallContext,
    deliveryId: Id<'Delivery'>,
  ): Promise<Result<DispatchJob, DispatchFailure>> {
    const { market } = context;
    const reopened = await this.unitOfWork.run(market, () =>
      refusingBrokenRules(async () => {
        const job = await this.jobs.findByDelivery(market, deliveryId);
        if (job === undefined) return err(jobNotFound());
        const change = redispatch(job, this.clock.now());
        await this.jobs.update(market, change.job);
        return ok(change.job);
      }),
    );
    if (reopened.ok) await this.advancer.advance(context, reopened.value.id);
    return reopened;
  }
}
