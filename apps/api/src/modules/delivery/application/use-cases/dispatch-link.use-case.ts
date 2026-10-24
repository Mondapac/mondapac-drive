import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac-drive/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac-drive/shared-kernel';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { applyDeliveryEvent, type DeliveryState } from '../../domain/delivery';
import { isFinal } from '../../domain/delivery-status';
import type { VehicleType } from '../../domain/vehicle';
import { saveChange, type DeliveryAccessDependencies } from '../deliveries';
import { refusingBrokenRules, type DeliveryFailure } from '../failure';

/** One delivery of `dispatch.courier-assigned.v1`. */
export interface RecordDispatchAssignmentInput {
  readonly delivery: EventDelivery;
  readonly deliveryId: Id<'Delivery'>;
  /** The courier's identity account id (dispatch's courier ids are account ids). */
  readonly courierId: Id;
  readonly vehicle: VehicleType;
}

export type DispatchLinkOutcome =
  | { readonly code: 'recorded' }
  | {
      readonly code: 'skipped';
      readonly reason: 'delivery.missing' | 'delivery.moved-on' | 'already-recorded';
    }
  | { readonly code: 'already-handled' };

const SYSTEM_ONLY: DeliveryFailure = Object.freeze({
  code: 'access.denied',
  message: 'Not allowed',
});

/**
 * Records dispatch's assignment on the delivery (rule `system`, from the subscription
 * `delivery.courier-assigned`). Idempotent twice over: the delivery inbox (`runOnce`) drops a
 * redelivered event, and an assignment the delivery already has is not recorded again.
 *
 * - DISPATCHING: `courier_assigned`.
 * - SCHEDULED (dispatch opened early): `dispatch_opened`, then `courier_assigned`.
 * - ASSIGNED or AT_PICKUP with another courier (a reassignment): `courier_unassigned` with the
 *   code `courier-reassigned`, then `courier_assigned`.
 * - Anything later, final, or missing: nothing is recorded; the event is still marked handled.
 *
 * Each step is its own version and writes its own event, caused by the consumed one.
 */
export class RecordDispatchAssignment extends UseCase<
  RecordDispatchAssignmentInput,
  DispatchLinkOutcome,
  DeliveryFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'delivery.record-dispatch-assignment',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('RecordDispatchAssignment');

  constructor(
    gate: UseCaseGate,
    private readonly deps: DeliveryAccessDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: RecordDispatchAssignmentInput,
  ): Promise<Result<DispatchLinkOutcome, DeliveryFailure>> {
    if (context.actor.kind !== 'system') return err(SYSTEM_ONLY);
    const { market } = context;
    const settings = this.deps.markets.get(market.marketId);
    const handled = await this.deps.unitOfWork.runOnce(market, input.delivery, () =>
      refusingBrokenRules(async (): Promise<Result<DispatchLinkOutcome, DeliveryFailure>> => {
        const delivery = await this.deps.deliveries.findById(market, input.deliveryId);
        if (delivery === undefined) return ok({ code: 'skipped', reason: 'delivery.missing' });
        const steps = stepsTo(delivery, input.courierId);
        if (typeof steps === 'string') return ok({ code: 'skipped', reason: steps });
        const now = this.deps.clock.now();
        const next = [
          ...steps,
          { type: 'courier_assigned' as const, courierId: input.courierId, vehicle: input.vehicle },
        ].reduce((state, event) => applyDeliveryEvent(state, event, now, settings), delivery);
        await saveChange(this.deps, context, delivery, next, input.delivery.eventId);
        return ok({ code: 'recorded' });
      }),
    );
    if (!handled.ok) return handled;
    const outcome: DispatchLinkOutcome = handled.value.handled
      ? handled.value.value
      : { code: 'already-handled' };
    this.#logger.log({
      msg: `delivery.dispatch-assignment.${outcome.code}`,
      ...(outcome.code === 'skipped' ? { reason: outcome.reason } : {}),
      deliveryId: input.deliveryId,
      eventId: input.delivery.eventId,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok(outcome);
  }
}

type Step =
  | { readonly type: 'dispatch_opened' }
  | {
      readonly type: 'courier_unassigned';
      readonly reasonCode: 'courier-reassigned';
    };

/** The steps before `courier_assigned`, or why nothing is recorded. */
function stepsTo(
  delivery: DeliveryState,
  courierId: string,
): readonly Step[] | 'delivery.moved-on' | 'already-recorded' {
  if (isFinal(delivery.status)) return 'delivery.moved-on';
  switch (delivery.status) {
    case 'DISPATCHING':
      return [];
    case 'SCHEDULED':
      return [{ type: 'dispatch_opened' }];
    case 'ASSIGNED':
    case 'AT_PICKUP':
      return delivery.courierId === courierId
        ? 'already-recorded'
        : [{ type: 'courier_unassigned', reasonCode: 'courier-reassigned' }];
    default:
      return 'delivery.moved-on';
  }
}

/** One delivery of `dispatch.job-exhausted.v1`. */
export interface RecordDispatchExhaustedInput {
  readonly delivery: EventDelivery;
  readonly deliveryId: Id<'Delivery'>;
}

/**
 * Flags a delivery that dispatch could not place as `dispatch-exhausted`, for a dispatcher to
 * assign by hand (rule `system`, from the subscription `delivery.dispatch-exhausted`). Only while
 * the delivery is still DISPATCHING; the flag is not a version and publishes no event. An
 * assignment or a cancel clears it.
 */
export class RecordDispatchExhausted extends UseCase<
  RecordDispatchExhaustedInput,
  DispatchLinkOutcome,
  DeliveryFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'delivery.record-dispatch-exhausted',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('RecordDispatchExhausted');

  constructor(
    gate: UseCaseGate,
    private readonly deps: DeliveryAccessDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: RecordDispatchExhaustedInput,
  ): Promise<Result<DispatchLinkOutcome, DeliveryFailure>> {
    if (context.actor.kind !== 'system') return err(SYSTEM_ONLY);
    const { market } = context;
    const handled = await this.deps.unitOfWork.runOnce(market, input.delivery, async () => {
      const raised = await this.deps.deliveries.raiseException(
        market,
        input.deliveryId,
        'dispatch-exhausted',
        'DISPATCHING',
      );
      return ok<DispatchLinkOutcome>(
        raised ? { code: 'recorded' } : { code: 'skipped', reason: 'delivery.moved-on' },
      );
    });
    if (!handled.ok) return handled;
    const outcome: DispatchLinkOutcome = handled.value.handled
      ? handled.value.value
      : { code: 'already-handled' };
    this.#logger.log({
      msg: `delivery.dispatch-exhausted.${outcome.code}`,
      deliveryId: input.deliveryId,
      eventId: input.delivery.eventId,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok(outcome);
  }
}
