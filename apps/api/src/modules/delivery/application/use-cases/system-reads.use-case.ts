import { err, ok } from '@mondapac-drive/shared-kernel';
import type { CallContext, GeoPoint, Id, Result, Temporal } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { DeliveryState } from '../../domain/delivery';
import { isFinal, type DeliveryStatus } from '../../domain/delivery-status';
import type { Temperature } from '../../domain/parcel';
import type { VehicleType } from '../../domain/vehicle';
import type { DeliveryAccessDependencies } from '../deliveries';
import type { DeliveryFailure } from '../failure';
import type { RecipientPins } from '../ports';
import type { DeliveryRef } from './merchant-deliveries.use-case';

// The reads other modules make of one delivery, in process and in the system context only
// (handoff 20): rule `system`, so no route can reach them, and the gate refuses any other actor.

const SYSTEM_ONLY: DeliveryFailure = Object.freeze({
  code: 'access.denied',
  message: 'Not allowed',
});

/** A stop as dispatch shows it to a courier: no contact name or phone. */
export interface DispatchStop {
  readonly address: string;
  readonly postcode: string;
  readonly point: GeoPoint;
}

/** What dispatch needs to open a job and offer it. */
export interface DeliveryForDispatch {
  readonly status: DeliveryStatus;
  readonly serviceAreaCode: string;
  readonly pickup: DispatchStop;
  readonly dropoff: DispatchStop;
  readonly distanceMetres: number;
  readonly weightGrams: number;
  readonly volumeLitres: number;
  readonly temperature: Temperature;
  readonly vehicle: VehicleType;
  readonly window: { readonly start: Temporal.Instant; readonly end: Temporal.Instant } | undefined;
}

/** What notifications needs to tell the recipient and the merchant. */
export interface DeliveryForNotification {
  readonly merchantId: string;
  /** The merchant's own reference (the marketplace's sub-order id), for its webhook. */
  readonly externalReference: string;
  readonly dropoffPhone: string;
  /**
   * The recipient's proof-of-delivery PIN, to text to the recipient; null once the delivery has
   * ended (delivered, returned or cancelled). Never written to an event or a log.
   */
  readonly recipientPin: string | null;
}

function dispatchStop(stop: DeliveryState['pickup']): DispatchStop {
  return { address: stop.address, postcode: stop.postcode, point: stop.point };
}

/** One delivery read in a read-only unit, or undefined. */
async function find(
  deps: DeliveryAccessDependencies,
  context: CallContext,
  deliveryId: Id<'Delivery'>,
): Promise<DeliveryState | undefined> {
  const found = await deps.unitOfWork.run(
    context.market,
    async () => ok(await deps.deliveries.findById(context.market, deliveryId)),
    { readOnly: true },
  );
  return found.ok ? found.value : undefined;
}

/** Throws on a refusal: a caller outside the system context is a programming error. */
function unwrap<T>(result: Result<T, { readonly code: string }>): T {
  if (!result.ok) throw new Error(`delivery system read refused: ${result.error.code}`);
  return result.value;
}

/** Dispatch's read of a delivery (rule `system`). */
export class DeliveryDispatchView extends UseCase<
  DeliveryRef,
  DeliveryForDispatch | undefined,
  DeliveryFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'delivery.view-for-dispatch',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: DeliveryAccessDependencies,
  ) {
    super(gate);
  }

  /** The delivery as dispatch needs it, or undefined when the Market has no such delivery. */
  async forDispatch(
    context: CallContext,
    deliveryId: Id<'Delivery'>,
  ): Promise<DeliveryForDispatch | undefined> {
    return unwrap(await this.execute(context, { deliveryId }));
  }

  protected async handle(
    context: CallContext,
    input: DeliveryRef,
  ): Promise<Result<DeliveryForDispatch | undefined, DeliveryFailure>> {
    if (context.actor.kind !== 'system') return err(SYSTEM_ONLY);
    const delivery = await find(this.deps, context, input.deliveryId);
    if (delivery === undefined) return ok(undefined);
    return ok({
      status: delivery.status,
      serviceAreaCode: delivery.serviceAreaCode,
      pickup: dispatchStop(delivery.pickup),
      dropoff: dispatchStop(delivery.dropoff),
      distanceMetres: delivery.quote.distanceMetres,
      weightGrams: delivery.parcel.weightGrams,
      volumeLitres: delivery.parcel.volumeLitres,
      temperature: delivery.parcel.temperature,
      vehicle: delivery.quote.vehicle,
      window: delivery.window,
    });
  }
}

export interface DeliveryRecipientsDependencies extends DeliveryAccessDependencies {
  readonly pins: RecipientPins;
}

/** Notifications' read of a delivery's recipient and merchant reference (rule `system`). */
export class DeliveryRecipients extends UseCase<
  DeliveryRef,
  DeliveryForNotification | undefined,
  DeliveryFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'delivery.view-recipients',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: DeliveryRecipientsDependencies,
  ) {
    super(gate);
  }

  /** The recipient's phone and PIN and the merchant's reference, or undefined when unknown. */
  async forNotification(
    context: CallContext,
    deliveryId: Id<'Delivery'>,
  ): Promise<DeliveryForNotification | undefined> {
    return unwrap(await this.execute(context, { deliveryId }));
  }

  protected async handle(
    context: CallContext,
    input: DeliveryRef,
  ): Promise<Result<DeliveryForNotification | undefined, DeliveryFailure>> {
    if (context.actor.kind !== 'system') return err(SYSTEM_ONLY);
    const delivery = await find(this.deps, context, input.deliveryId);
    if (delivery === undefined) return ok(undefined);
    return ok({
      merchantId: delivery.merchantId,
      externalReference: delivery.externalReference,
      dropoffPhone: delivery.dropoff.contactPhone,
      recipientPin: isFinal(delivery.status)
        ? null
        : this.deps.pins.pinFor(
            context.market,
            delivery.id,
            this.deps.markets.get(context.market.marketId).proofOfDelivery.pinLength,
          ),
    });
  }
}
