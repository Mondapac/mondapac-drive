import { Inject, Injectable } from '@nestjs/common';
import {
  ok,
  type CallContext,
  type Clock,
  type Id,
  type IdGenerator,
  type Result,
  type Temporal,
} from '@mondapac-drive/shared-kernel';
import { CLOCK } from '../../../../platform/clock/clock.module';
import { ID_GENERATOR } from '../../../../platform/ids/ids.module';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { openDispatchJob, type DispatchJob } from '../../domain/dispatch-job';
import type { DispatchRequirements } from '../../domain/matching';
import { refusingBrokenRules, type DispatchFailure } from '../failure';
import { JobAdvancer } from '../job-advancer';
import {
  DISPATCH_JOB_REPOSITORY,
  DISPATCH_SETTINGS,
  type DispatchJobRepository,
  type DispatchSettingsProvider,
} from '../ports';

export interface OpenDispatchJobInput {
  readonly deliveryId: Id<'Delivery'>;
  readonly requirements: DispatchRequirements;
  /** The start of a scheduled delivery's window; absent for on-demand. */
  readonly windowStart?: Temporal.Instant;
}

/**
 * Opens the dispatch job of a booked delivery (system). Idempotent per delivery: a repeated
 * booking event returns the job already opened. An on-demand job sends its first wave at once.
 */
@Injectable()
export class OpenDispatchJob {
  constructor(
    @Inject(DISPATCH_JOB_REPOSITORY) private readonly jobs: DispatchJobRepository,
    @Inject(DISPATCH_SETTINGS) private readonly settings: DispatchSettingsProvider,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly advancer: JobAdvancer,
  ) {}

  async run(
    context: CallContext,
    input: OpenDispatchJobInput,
  ): Promise<Result<DispatchJob, DispatchFailure>> {
    const { market } = context;
    const settings = this.settings.get(market.marketId);
    const opened = await this.unitOfWork.run(market, () =>
      refusingBrokenRules(async () => {
        const existing = await this.jobs.findByDelivery(market, input.deliveryId);
        if (existing !== undefined) return ok(existing);
        const job = openDispatchJob(
          {
            id: this.ids.next<'DispatchJob'>(),
            marketId: market.marketId,
            deliveryId: input.deliveryId,
            requirements: input.requirements,
            ...(input.windowStart === undefined ? {} : { windowStart: input.windowStart }),
          },
          this.clock.now(),
          settings,
        );
        if (await this.jobs.insert(market, job)) return ok(job);
        // Another delivery of the same booking event won the race.
        return ok((await this.jobs.findByDelivery(market, input.deliveryId)) ?? job);
      }),
    );
    if (opened.ok && opened.value.status === 'OFFERING' && opened.value.round === 0) {
      await this.advancer.advance(context, opened.value.id);
    }
    return opened;
  }
}
