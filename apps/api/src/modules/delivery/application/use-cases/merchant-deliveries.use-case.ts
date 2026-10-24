import { err } from '@mondapac-drive/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { BOOKING_CANCEL, BOOKING_VIEW } from '../../contracts/permissions';
import type { DeliveryState } from '../../domain/delivery';
import {
  ACCESS_DENIED,
  merchantOf,
  readDelivery,
  recordEvent,
  type DeliveryAccessDependencies,
} from '../deliveries';
import type { DeliveryFailure } from '../failure';

export interface DeliveryRef {
  readonly deliveryId: Id<'Delivery'>;
}

/**
 * One of the merchant's own deliveries, with its history. Rule `permissions
 * [delivery.booking.view]`. Another merchant's delivery answers `delivery.not-found`, as a
 * missing one.
 */
export class ViewBooking extends UseCase<DeliveryRef, DeliveryState, DeliveryFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'delivery.view-booking',
    rule: { kind: 'permissions', allOf: [BOOKING_VIEW.key] },
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
    const merchantId = merchantOf(context);
    if (merchantId === null) return Promise.resolve(err(ACCESS_DENIED));
    return readDelivery(
      this.deps,
      context.market,
      input.deliveryId,
      (delivery) => delivery.merchantId === merchantId,
    );
  }
}

export interface CancelInput extends DeliveryRef {
  readonly reason: string;
}

/**
 * The merchant cancels one of its own deliveries, before pickup (the domain's transition).
 * Rule `permissions [delivery.booking.cancel]`.
 */
export class CancelBooking extends UseCase<CancelInput, DeliveryState, DeliveryFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'delivery.cancel-booking',
    rule: { kind: 'permissions', allOf: [BOOKING_CANCEL.key] },
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
    const merchantId = merchantOf(context);
    if (merchantId === null) return Promise.resolve(err(ACCESS_DENIED));
    return recordEvent(
      this.deps,
      context.market,
      input.deliveryId,
      { type: 'cancelled', reason: input.reason },
      (delivery) => delivery.merchantId === merchantId,
      ['cancelled'],
    );
  }
}
