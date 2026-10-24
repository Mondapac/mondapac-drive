import { Inject, Injectable } from '@nestjs/common';
import { ok, type CallContext, type Clock } from '@mondapac-drive/shared-kernel';
import { CLOCK } from '../../../../platform/clock/clock.module';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { JobAdvancer } from '../job-advancer';
import { DISPATCH_JOB_REPOSITORY, type DispatchJobRepository } from '../ports';

/** The most jobs one sweep advances for a Market; the rest wait for the next tick. */
export const SWEEP_BATCH = 100;

/**
 * The sweep (system, run by the `dispatch.advance-jobs` job): every open job whose next action
 * is due is advanced in its own unit. Offer timeouts run here, never on a timer in the domain.
 * Safe to run twice and concurrently: a job changed meanwhile is skipped as stale.
 */
@Injectable()
export class AdvanceDispatchJobs {
  constructor(
    @Inject(DISPATCH_JOB_REPOSITORY) private readonly jobs: DispatchJobRepository,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly advancer: JobAdvancer,
  ) {}

  async run(context: CallContext): Promise<{ readonly advanced: number }> {
    const { market } = context;
    const due = await this.unitOfWork.run(
      market,
      async () => ok(await this.jobs.findDue(market, this.clock.now(), SWEEP_BATCH)),
      { readOnly: true },
    );
    let advanced = 0;
    for (const id of due.ok ? due.value : []) {
      if ((await this.advancer.advance(context, id)) === 'advanced') advanced += 1;
    }
    return { advanced };
  }
}
