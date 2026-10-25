import { err, ok, type CallContext, type Clock, type Result } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { followJob, type CourierJob, type DeliveryReport } from '../../domain/courier-job';
import { isSystem } from '../access';
import { forbidden, refusingBrokenRules, type FleetFailure } from '../failure';
import type { CourierJobRepository } from '../ports';

export interface FollowDeliveryInput extends DeliveryReport {
  /** The event's delivery, handed on unchanged so the unit records it in fleet's inbox. */
  readonly delivery: EventDelivery;
}

export interface FollowDeliveryDependencies {
  readonly jobs: CourierJobRepository;
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
}

/**
 * Fleet follows the deliveries couriers carry from delivery's events (handoff 31): an assigned
 * courier holds the job, an unassign frees it, and delivered, returned or cancelled end it. The
 * courier's active delivery, the 409 on going offline and dispatch's pool of free couriers all
 * read these jobs. Each event is handled once (`runOnce`); a late or repeated one changes
 * nothing. Rule `system`: only the subscribers call it.
 */
export class FollowDelivery extends UseCase<
  FollowDeliveryInput,
  CourierJob | undefined,
  FleetFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'fleet.follow-delivery',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: FollowDeliveryDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: FollowDeliveryInput,
  ): Promise<Result<CourierJob | undefined, FleetFailure>> {
    if (!isSystem(context)) return err(forbidden());
    const { market } = context;
    const { jobs, unitOfWork, clock } = this.deps;
    const { delivery, ...report } = input;
    const handled = await unitOfWork.runOnce(market, delivery, () =>
      refusingBrokenRules(async () => {
        const current = await jobs.find(market, report.deliveryId);
        const next = followJob(current, report, clock.now());
        if (next !== current) await jobs.save(market, next, current?.deliveryVersion);
        return ok(next);
      }),
    );
    if (!handled.ok) return handled;
    return ok(handled.value.handled ? handled.value.value : undefined);
  }
}
