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
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { isCourierId } from '../../domain/location-ping';
import {
  followDelivery,
  type DeliveryRoute,
  type TrackedDelivery,
  type TrackedStatus,
} from '../../domain/tracked-delivery';
import { ACCESS_DENIED, isSystem } from '../callers';
import { failure, type TrackingFailure } from '../failure';
import type { DeliveryRoutes, TrackingRepository } from '../ports';

export interface FollowDeliveryInput {
  /** The event's delivery, handed on unchanged so the unit records it in tracking's inbox. */
  readonly delivery: EventDelivery;
  readonly deliveryId: Id<'Delivery'>;
  /** The event's aggregate version: one per delivery change. */
  readonly aggregateVersion: number;
  readonly status: TrackedStatus;
  /** Absent when the event says nothing of the courier; null when nobody carries it. */
  readonly courierId?: string | null;
}

export interface FollowDeliveryDependencies {
  readonly tracking: TrackingRepository;
  readonly routes: DeliveryRoutes;
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
}

/**
 * Tracking follows the delivery lifecycle from delivery's events (handoff 26): booked starts
 * tracking, a status change moves the phase and the courier, and cancelled or DELIVERED ends it,
 * after which the customer link answers 410 `tracking.ended`. Each event is handled once
 * (`runOnce`); a late or repeated one changes nothing. The first event of a delivery reads its
 * route from delivery before the unit opens. Rule `system`: only the subscribers call it.
 */
export class FollowDelivery extends UseCase<
  FollowDeliveryInput,
  TrackedDelivery | undefined,
  TrackingFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'tracking.follow-delivery',
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
  ): Promise<Result<TrackedDelivery | undefined, TrackingFailure>> {
    if (!isSystem(context)) return err(ACCESS_DENIED);
    if (typeof input.courierId === 'string' && !isCourierId(input.courierId)) {
      return err(
        failure('tracking.invalid', 'The courier id is not valid', { field: 'courierId' }),
      );
    }
    const { market } = context;
    const { tracking, routes, unitOfWork, clock } = this.deps;
    const known = await unitOfWork.run(
      market,
      async () => ok(await tracking.findDelivery(market, input.deliveryId)),
      { readOnly: true },
    );
    if (!known.ok) return known;
    // The route is delivery's: read it outside tracking's unit, and only for a new delivery.
    let route: DeliveryRoute | undefined;
    if (known.value === undefined) {
      route = await routes.routeOf(context, input.deliveryId);
      if (route === undefined) {
        return err(failure('tracking.delivery-not-found', 'Delivery has no route for it yet'));
      }
    }
    const report = {
      deliveryVersion: input.aggregateVersion,
      status: input.status,
      ...(input.courierId === undefined ? {} : { courierId: input.courierId }),
    };
    const handled = await unitOfWork.runOnce(market, input.delivery, async () => {
      // Read again inside the unit: another event of the delivery may have started it since.
      const current = await tracking.findDelivery(market, input.deliveryId);
      const next = followDelivery(current, input.deliveryId, report, route, clock.now());
      if (!next.ok) {
        return err(failure('tracking.delivery-not-found', 'Delivery has no route for it yet'));
      }
      if (next.value !== current) await tracking.saveDelivery(market, next.value);
      return ok(next.value);
    });
    if (!handled.ok) return handled;
    return ok(handled.value.handled ? handled.value.value : undefined);
  }
}
