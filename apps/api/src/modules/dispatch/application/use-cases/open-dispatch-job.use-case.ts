import {
  err,
  ok,
  type CallContext,
  type Clock,
  type Id,
  type IdGenerator,
  type Result,
} from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { openDispatchJob, type DispatchJob, type OfferStops } from '../../domain/dispatch-job';
import type { DispatchRequirements } from '../../domain/matching';
import { isSystem } from '../callers';
import {
  accessDenied,
  deliveryNotFound,
  refusingBrokenRules,
  type DispatchFailure,
} from '../failure';
import type { JobAdvancer } from '../job-advancer';
import type {
  DeliveryFacts,
  DeliveryForDispatch,
  DispatchJobRepository,
  DispatchSettingsProvider,
} from '../ports';

export interface OpenDispatchJobInput {
  /** The booking event's delivery: the job is opened once per event and subscriber. */
  readonly delivery: EventDelivery;
  readonly deliveryId: Id<'Delivery'>;
  /** The booking event's aggregate version. */
  readonly deliveryVersion: number;
}

export interface OpenDispatchJobDependencies {
  readonly jobs: DispatchJobRepository;
  readonly facts: DeliveryFacts;
  readonly settings: DispatchSettingsProvider;
  readonly unitOfWork: UnitOfWork;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly advancer: JobAdvancer;
}

/** The delivery statuses in which a delivery still waits for a courier. */
const WAITING_FOR_COURIER = new Set(['SCHEDULED', 'DISPATCHING']);

/** What the delivery needs from its courier, and what the courier's offer shows. */
export function requirementsOf(delivery: DeliveryForDispatch): DispatchRequirements {
  return {
    serviceAreaCode: delivery.serviceAreaCode,
    pickup: delivery.pickup.point,
    minimumVehicle: delivery.vehicle,
    weightGrams: delivery.weightGrams,
    volumeLitres: delivery.volumeLitres,
    temperature: delivery.temperature,
  };
}

export function stopsOf(delivery: DeliveryForDispatch): OfferStops {
  return {
    pickupAddress: delivery.pickup.address,
    dropoffAddress: delivery.dropoff.address,
    dropoff: delivery.dropoff.point,
    tripDistanceMetres: delivery.distanceMetres,
  };
}

/**
 * Opens the dispatch job of a booked delivery, from the `delivery.booked` subscriber: the
 * requirements and the offer's stops come from delivery's read for dispatch. Idempotent per
 * delivery: a repeated booking event returns the job already opened. A delivery that no longer
 * waits for a courier (cancelled before the event arrived) opens nothing. An on-demand job
 * sends its first wave at once; a scheduled one waits until the Market's lead time before its
 * window. Rule `system`.
 */
export class OpenDispatchJob extends UseCase<
  OpenDispatchJobInput,
  DispatchJob | null,
  DispatchFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'dispatch.open-dispatch-job',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OpenDispatchJobDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OpenDispatchJobInput,
  ): Promise<Result<DispatchJob | null, DispatchFailure>> {
    if (!isSystem(context)) return err(accessDenied());
    const { jobs, facts, unitOfWork, ids, clock, advancer } = this.deps;
    const { market } = context;
    const delivery = await facts.forDispatch(context, input.deliveryId);
    if (delivery === undefined) return err(deliveryNotFound());
    if (!WAITING_FOR_COURIER.has(delivery.status)) return ok(null);
    const settings = this.deps.settings.get(market.marketId);

    const opened = await unitOfWork.runOnce(market, input.delivery, () =>
      refusingBrokenRules(async () => {
        const existing = await jobs.findByDelivery(market, input.deliveryId);
        if (existing !== undefined) return ok(existing);
        const job = openDispatchJob(
          {
            id: ids.next<'DispatchJob'>(),
            marketId: market.marketId,
            deliveryId: input.deliveryId,
            requirements: requirementsOf(delivery),
            stops: stopsOf(delivery),
            deliveryVersion: input.deliveryVersion,
            ...(delivery.window === undefined ? {} : { windowStart: delivery.window.start }),
          },
          clock.now(),
          settings,
        );
        if (await jobs.insert(market, job)) return ok(job);
        // Another delivery of the same booking event won the race.
        return ok((await jobs.findByDelivery(market, input.deliveryId)) ?? job);
      }),
    );
    if (!opened.ok) return opened;
    if (!opened.value.handled) {
      return ok((await this.peek(context, input.deliveryId)) ?? null);
    }
    const job = opened.value.value;
    if (job.status === 'OFFERING' && job.round === 0) await advancer.advance(context, job.id);
    return ok(job);
  }

  private async peek(
    context: CallContext,
    deliveryId: Id<'Delivery'>,
  ): Promise<DispatchJob | undefined> {
    const { market } = context;
    const read = await this.deps.unitOfWork.run(
      market,
      async () => ok(await this.deps.jobs.findByDelivery(market, deliveryId)),
      { readOnly: true },
    );
    return read.ok ? read.value : undefined;
  }
}
