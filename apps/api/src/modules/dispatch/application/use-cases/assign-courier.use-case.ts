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
import type { VehicleType } from '../../domain/courier';
import { assignManually, type DispatchJob } from '../../domain/dispatch-job';
import { jobNotFound, refusingBrokenRules, type DispatchFailure } from '../failure';
import {
  DELIVERY_LINK,
  DISPATCH_JOB_REPOSITORY,
  type DeliveryLink,
  type DispatchJobRepository,
} from '../ports';

export interface AssignCourierInput {
  readonly deliveryId: Id<'Delivery'>;
  readonly courierId: Id<'Courier'>;
  readonly vehicle: VehicleType;
}

/**
 * A dispatcher assigns a delivery to a courier, or replaces the assigned courier (dispatcher;
 * the route comes with authentication in work package 2). Offers still out are withdrawn.
 */
@Injectable()
export class AssignCourier {
  constructor(
    @Inject(DISPATCH_JOB_REPOSITORY) private readonly jobs: DispatchJobRepository,
    @Inject(DELIVERY_LINK) private readonly delivery: DeliveryLink,
    @Inject(OUTBOX_WRITER) private readonly outbox: OutboxWriter,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async run(
    context: CallContext,
    input: AssignCourierInput,
  ): Promise<Result<DispatchJob, DispatchFailure>> {
    const { market } = context;
    const assigned = await this.unitOfWork.run(market, () =>
      refusingBrokenRules(async () => {
        const job = await this.jobs.findByDelivery(market, input.deliveryId);
        if (job === undefined) return err(jobNotFound());
        const change = assignManually(job, input.courierId, input.vehicle, this.clock.now());
        await this.jobs.update(market, change.job);
        await this.outbox.append(context, change.events);
        return ok(change.job);
      }),
    );
    if (assigned.ok) {
      await this.delivery.courierAssigned(
        context,
        input.deliveryId,
        input.courierId,
        input.vehicle,
      );
    }
    return assigned;
  }
}
