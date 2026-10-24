import {
  err,
  ok,
  type CallContext,
  type Clock,
  type Id,
  type Result,
} from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { cancelJob } from '../../domain/dispatch-job';
import { isSystem } from '../callers';
import { accessDenied, refusingBrokenRules, type DispatchFailure } from '../failure';
import type { DispatchJobRepository } from '../ports';

export interface CancelDispatchJobInput {
  /** The cancellation event's delivery: handled once per event and subscriber. */
  readonly delivery: EventDelivery;
  readonly deliveryId: Id<'Delivery'>;
}

export interface CancelDispatchJobDependencies {
  readonly jobs: DispatchJobRepository;
  readonly outbox: OutboxWriter;
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
}

/**
 * The delivery was cancelled (`delivery.cancelled` subscriber): offers still out are withdrawn,
 * the job stops and forgets the addresses. A cancellation is final, so it applies whatever
 * delivery events arrive after it. Rule `system`.
 */
export class CancelDispatchJob extends UseCase<
  CancelDispatchJobInput,
  { readonly cancelled: boolean },
  DispatchFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'dispatch.cancel-dispatch-job',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CancelDispatchJobDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CancelDispatchJobInput,
  ): Promise<Result<{ readonly cancelled: boolean }, DispatchFailure>> {
    if (!isSystem(context)) return err(accessDenied());
    const { jobs, outbox, unitOfWork, clock } = this.deps;
    const { market } = context;
    const done = await unitOfWork.runOnce(market, input.delivery, () =>
      refusingBrokenRules<{ readonly cancelled: boolean }>(async () => {
        const job = await jobs.findByDelivery(market, input.deliveryId);
        if (job === undefined || job.status === 'CANCELLED') return ok({ cancelled: false });
        const change = cancelJob(job, clock.now());
        await jobs.update(market, change.job);
        if (change.events.length > 0) await outbox.append(context, change.events);
        return ok({ cancelled: true });
      }),
    );
    if (!done.ok) return done;
    return ok(done.value.handled ? done.value.value : { cancelled: false });
  }
}
