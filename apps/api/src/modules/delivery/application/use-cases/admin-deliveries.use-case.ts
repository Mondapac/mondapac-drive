import { err, ok } from '@mondapac-drive/shared-kernel';
import type { CourierAccounts } from '../ports';
import type { CallContext, Id, Result } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { DELIVERY_CANCEL, DELIVERY_DISPATCH, DELIVERY_VIEW } from '../../contracts/permissions';
import type { DeliveryEventInput, DeliveryState } from '../../domain/delivery';
import type { DeliveryEventType, DeliveryStatus } from '../../domain/delivery-status';
import {
  ACCESS_DENIED,
  isAdmin,
  readDelivery,
  recordEvent,
  type DeliveryAccessDependencies,
} from '../deliveries';
import type { DeliveryFailure } from '../failure';
import type { DeliverySummary } from '../ports';
import type { CancelInput, DeliveryRef } from './merchant-deliveries.use-case';

/** The list row, for the presentation layer (which reaches application only through use cases). */
export type { DeliverySummary };

/** The events of dispatch. */
export const DISPATCH_EVENT_TYPES: readonly DeliveryEventType[] = Object.freeze([
  'dispatch_opened',
  'courier_assigned',
  'courier_unassigned',
]);

export interface DispatchInput extends DeliveryRef {
  readonly event: DeliveryEventInput;
}

export interface DispatchDeliveryDependencies extends DeliveryAccessDependencies {
  readonly couriers: CourierAccounts;
}

const anyDelivery = (): boolean => true;

/** The largest page of the delivery list; the route's default page is smaller. */
export const MAX_DELIVERY_PAGE = 100;

export interface ListDeliveriesInput {
  readonly statuses?: readonly DeliveryStatus[];
  readonly merchantId?: string;
  readonly courierId?: string;
  /** `next` of the previous page; absent for the first page. */
  readonly before?: Id<'Delivery'>;
  readonly limit: number;
}

export interface DeliveryPage {
  /** Newest first. */
  readonly items: readonly DeliverySummary[];
  /** The `before` of the next page, or null when this page was the last. */
  readonly next: Id<'Delivery'> | null;
}

/**
 * The deliveries of the Market, newest first, filtered by status, merchant or courier, for the
 * operations panel's list. Rule `permissions [delivery.delivery.view]`. Summaries only: the
 * stops' addresses and contacts are read on one delivery's detail.
 */
export class ListDeliveries extends UseCase<ListDeliveriesInput, DeliveryPage, DeliveryFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'delivery.list-deliveries',
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
    input: ListDeliveriesInput,
  ): Promise<Result<DeliveryPage, DeliveryFailure>> {
    if (!isAdmin(context)) return Promise.resolve(err(ACCESS_DENIED));
    const limit = Math.min(Math.max(Math.trunc(input.limit), 1), MAX_DELIVERY_PAGE);
    const { market } = context;
    return this.deps.unitOfWork.run(
      market,
      async () => {
        // One row more than the page tells whether another page exists.
        const rows = await this.deps.deliveries.list(market, { ...input, limit: limit + 1 });
        const items = rows.slice(0, limit);
        const next = rows.length > limit ? items[items.length - 1]!.id : null;
        return ok({ items, next });
      },
      { readOnly: true },
    );
  }
}

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
 * account, and an assignment is refused unless it names an active courier account of the Market
 * (`delivery.courier-not-active`; Hassan, WP2 review).
 */
export class DispatchDelivery extends UseCase<DispatchInput, DeliveryState, DeliveryFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'delivery.dispatch-delivery',
    rule: { kind: 'permissions', allOf: [DELIVERY_DISPATCH.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: DispatchDeliveryDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: DispatchInput,
  ): Promise<Result<DeliveryState, DeliveryFailure>> {
    if (!isAdmin(context)) return err(ACCESS_DENIED);
    const { courierId } = input.event;
    if (input.event.type === 'courier_assigned' && courierId !== undefined) {
      const active = await this.deps.couriers.isActive(context, courierId);
      if (active === undefined) return err(ACCESS_DENIED);
      if (!active) {
        return err({
          code: 'delivery.courier-not-active',
          message: 'The courier is not an active courier of this Market',
        });
      }
    }
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
