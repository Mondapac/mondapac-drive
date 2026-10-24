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
import { OUTBOX_WRITER, type OutboxWriter } from '../../../../platform/events/outbox-writer';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { answerOffer, pendingOffers, type DispatchJob } from '../../domain/dispatch-job';
import { jobNotFound, refusingBrokenRules, type DispatchFailure } from '../failure';
import { JobAdvancer } from '../job-advancer';
import {
  DELIVERY_LINK,
  DISPATCH_JOB_REPOSITORY,
  type DeliveryLink,
  type DispatchJobRepository,
} from '../ports';

export interface AnswerOfferInput {
  readonly deliveryId: Id<'Delivery'>;
  readonly courierId: Id<'Courier'>;
  readonly answer: 'accept' | 'decline';
}

/**
 * A courier accepts or declines the offer they hold (courier; the route comes with
 * authentication in work package 2, and the courier is then the caller). An accept assigns the
 * delivery; the last decline of a wave sends the next one at once.
 */
@Injectable()
export class AnswerOffer {
  constructor(
    @Inject(DISPATCH_JOB_REPOSITORY) private readonly jobs: DispatchJobRepository,
    @Inject(DELIVERY_LINK) private readonly delivery: DeliveryLink,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriter,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly advancer: JobAdvancer,
  ) {}

  async run(
    context: CallContext,
    input: AnswerOfferInput,
  ): Promise<Result<DispatchJob, DispatchFailure>> {
    const { market } = context;
    const answered = await this.unitOfWork.run(market, () =>
      refusingBrokenRules(async () => {
        const job = await this.jobs.findByDelivery(market, input.deliveryId);
        if (job === undefined) return err(jobNotFound());
        const change = answerOffer(job, input.courierId, input.answer, this.clock.now());
        await this.jobs.update(market, change.job);
        await this.outbox.append(context, change.events);
        return ok(change.job);
      }),
    );
    if (!answered.ok) return answered;
    const job = answered.value;
    if (job.assignment !== undefined) {
      const { courierId, vehicle } = job.assignment;
      await this.delivery.courierAssigned(context, job.deliveryId, courierId, vehicle);
    } else if (pendingOffers(job).length === 0) {
      await this.advancer.advance(context, job.id);
    }
    return answered;
  }
}
