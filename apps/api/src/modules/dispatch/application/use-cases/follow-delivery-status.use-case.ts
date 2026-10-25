import {
  err,
  ok,
  Temporal,
  type CallContext,
  type Clock,
  type Id,
  type Result,
} from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  followedDeliveryVersion,
  isOpen,
  openEarly,
  recordAssignment,
  recordCollection,
  redispatch,
  type DispatchJob,
  type JobChange,
  type OfferStops,
} from '../../domain/dispatch-job';
import { isSystem } from '../callers';
import {
  accessDenied,
  deliveryNotFound,
  refusingBrokenRules,
  type DispatchFailure,
} from '../failure';
import type { JobAdvancer } from '../job-advancer';
import type { DeliveryFacts, DispatchJobRepository, DispatchSettingsProvider } from '../ports';
import { stopsOf } from '../offer-stops';

/** The reason delivery gives a step back to DISPATCHING that is half of a reassignment. */
export const REASSIGNMENT_REASON = 'courier-reassigned';

export interface FollowDeliveryStatusInput {
  /** The status event's delivery: handled once per event and subscriber. */
  readonly delivery: EventDelivery;
  readonly deliveryId: Id<'Delivery'>;
  /** The delivery's aggregate version after the change. */
  readonly deliveryVersion: number;
  /** The delivery's status after and before the change, as events carry it (`assigned`). */
  readonly status: string;
  readonly previousStatus: string;
  /** The delivery's courier after the change. */
  readonly courierId: Id<'Courier'> | null;
  readonly reason: string | null;
}

export interface FollowDeliveryStatusDependencies {
  readonly jobs: DispatchJobRepository;
  readonly facts: DeliveryFacts;
  readonly settings: DispatchSettingsProvider;
  readonly outbox: OutboxWriter;
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
  readonly advancer: JobAdvancer;
}

/** The delivery statuses in which its courier has collected the parcel, as events carry them. */
const COLLECTED_STATUSES: ReadonlySet<string> = new Set([
  'picked-up',
  'at-dropoff',
  'delivered',
  'delivery-failed',
  'returning',
  'returned',
]);

/** Whether the delivery lost its courier and needs one again (not half of a reassignment). */
function droppedCourier(input: FollowDeliveryStatusInput): boolean {
  return (
    input.previousStatus === 'assigned' &&
    input.status === 'dispatching' &&
    input.reason !== REASSIGNMENT_REASON
  );
}

/**
 * Keeps the dispatch job in step with its delivery (`delivery.status-changed` subscriber):
 * - the courier was taken off (assigned -> dispatching, a dispatcher's unassign): offering
 *   starts again without that courier, the offer's addresses read again from the delivery;
 * - a courier was assigned outside dispatch (a dispatcher on the delivery's route): offers out
 *   are withdrawn and the job records that courier;
 * - a dispatcher opened a scheduled delivery early (scheduled -> dispatching): the job opens;
 * - the courier collected the parcel (picked-up or later): the job is done for good, so a
 *   dispatcher can no longer reassign it.
 * Events come at least once and in no order: one at or below the delivery version the job last
 * followed changes nothing, and half of a reassignment is ignored. Rule `system`.
 */
export class FollowDeliveryStatus extends UseCase<
  FollowDeliveryStatusInput,
  DispatchJob | null,
  DispatchFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'dispatch.follow-delivery-status',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: FollowDeliveryStatusDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: FollowDeliveryStatusInput,
  ): Promise<Result<DispatchJob | null, DispatchFailure>> {
    if (!isSystem(context)) return err(accessDenied());
    const { jobs, facts, outbox, unitOfWork, clock, advancer } = this.deps;
    const { market } = context;

    // The addresses are read before the unit opens: they come from another module.
    let stops: OfferStops | undefined;
    if (droppedCourier(input)) {
      const delivery = await facts.forDispatch(context, input.deliveryId);
      if (delivery === undefined) return err(deliveryNotFound());
      stops = stopsOf(delivery, this.deps.settings.get(market.marketId));
    }

    const followed = await unitOfWork.runOnce(market, input.delivery, () =>
      refusingBrokenRules<DispatchJob | null>(async () => {
        const job = await jobs.findByDelivery(market, input.deliveryId);
        // No job yet: the booking event opens it from the delivery as it is then.
        if (job === undefined) return ok(null);
        if (input.deliveryVersion <= job.deliveryVersion) return ok(job);
        const now = clock.now();
        const change = this.changeOf(job, input, stops, now);
        const next = followedDeliveryVersion(job, change.job, input.deliveryVersion);
        await jobs.update(market, next);
        if (change.events.length > 0) await outbox.append(context, change.events);
        return ok(next);
      }),
    );
    if (!followed.ok) return followed;
    const job = followed.value.handled ? followed.value.value : null;
    // An opened or restarted job sends its wave now rather than on the next sweep.
    const due = job?.nextActionAt;
    if (job !== null && isOpen(job) && due !== undefined) {
      if (Temporal.Instant.compare(due, clock.now()) <= 0) await advancer.advance(context, job.id);
    }
    return ok(job);
  }

  private changeOf(
    job: DispatchJob,
    input: FollowDeliveryStatusInput,
    stops: OfferStops | undefined,
    now: Temporal.Instant,
  ): JobChange {
    if (COLLECTED_STATUSES.has(input.status)) return recordCollection(job, input.courierId, now);
    if (stops !== undefined && job.status === 'ASSIGNED') return redispatch(job, stops, now);
    if (input.status === 'assigned' && input.courierId !== null) {
      return recordAssignment(job, input.courierId, now);
    }
    if (input.previousStatus === 'scheduled' && input.status === 'dispatching') {
      return openEarly(job, now);
    }
    return { job, events: [] };
  }
}
