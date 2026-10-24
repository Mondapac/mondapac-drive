import { err } from '@mondapac-drive/shared-kernel';
import type { CallContext, Result } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  DELIVERY_CANCEL,
  DELIVERY_DISPATCH,
  DELIVERY_VIEW,
} from '../../contracts/permissions';
import type { DeliveryEventInput, DeliveryState } from '../../domain/delivery';
import type { DeliveryEventType } from '../../domain/delivery-status';
import {
  ACCESS_DENIED,
  isAdmin,
  readDelivery,
  recordEvent,
  type DeliveryAccessDependencies,
} from '../deliveries';
import type { DeliveryFailure } from '../failure';
import type { CancelInput, DeliveryRef } from './merchant-deliveries.use-case';

/** The events of dispatch. */
export const DISPATCH_EVENT_TYPES: readonly DeliveryEventType[] = Object.freeze([
  'dispatch_opened',
  'courier_assigned',
  'courier_unassigned',
]);

export interface DispatchInput extends DeliveryRef {
  readonly event: DeliveryEventInput;
}

const anyDelivery = (): boolean => true;

/** Any delivery of the Market, with its history. Rule `permissions [delivery.delivery.view]`. */
export class ViewDelivery extends UseCase<DeliveryRef, DeliveryState, DeliveryFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'delivery.view-delivery',
    rule: { kind: 'permissions', allOf: [DELIVERY_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: DeliveryAccessDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: DeliveryRef,
  ): Promise<Result<DeliveryState, DeliveryFailure>> {
    if (!isAdmin(context)) return Promise.resolve(err(ACCESS_DENIED));
    return readDelivery(this.deps, context.market, input.deliveryId, anyDelivery);
  }
}

/**
 * Dispatch: open dispatch of a scheduled delivery, assign a courier with a vehicle, or unassign.
 * Rule `permissions [delivery.delivery.dispatch]`. The courier id is the courier's identity
 * account; that it names an active courier is fleet's check when fleet lands.
 */
export class DispatchDelivery extends UseCase<DispatchInput, DeliveryState, DeliveryFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'delivery.dispatch-delivery',
    rule: { kind: 'permissions', allOf: [DELIVERY_DISPATCH.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: DeliveryAccessDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: DispatchInput,
  ): Promise<Result<DeliveryState, DeliveryFailure>> {
    if (!isAdmin(context)) return Promise.resolve(err(ACCESS_DENIED));
    return recordEvent(
      this.deps,
      context.market,
      input.deliveryId,
      input.event,
      anyDelivery,
      DISPATCH_EVENT_TYPES,
    );
  }
}

/**
 * An operator or dispatcher cancels any delivery of the Market before pickup, with a reason.
 * Rule `permissions [delivery.delivery.cancel]`.
 */
export class CancelDelivery extends UseCase<CancelInput, DeliveryState, DeliveryFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'delivery.cancel-delivery',
    rule: { kind: 'permissions', allOf: [DELIVERY_CANCEL.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: DeliveryAccessDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: CancelInput,
  ): Promise<Result<DeliveryState, DeliveryFailure>> {
    if (!isAdmin(context)) return Promise.resolve(err(ACCESS_DENIED));
    return recordEvent(
      this.deps,
      context.market,
      input.deliveryId,
      { type: 'cancelled', reason: input.reason },
      anyDelivery,
      ['cancelled'],
    );
  }
}
