import { err } from '@mondapac-drive/shared-kernel';
import type { CallContext, Result } from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { ASSIGNMENT_REPORT, ASSIGNMENT_VIEW } from '../../contracts/permissions';
import type { DeliveryEventInput, DeliveryState } from '../../domain/delivery';
import type { DeliveryEventType } from '../../domain/delivery-status';
import {
  ACCESS_DENIED,
  courierOf,
  readDelivery,
  recordEvent,
  type DeliveryAccessDependencies,
} from '../deliveries';
import type { DeliveryFailure } from '../failure';
import type { DeliveryRef } from './merchant-deliveries.use-case';

/** The events a courier reports on its own assignment: progress, proof and the return. */
export const COURIER_EVENT_TYPES: readonly DeliveryEventType[] = Object.freeze([
  'arrived_at_pickup',
  'picked_up',
  'arrived_at_dropoff',
  'delivered',
  'delivery_failed',
  'return_started',
  'returned',
]);

/** What the courier reports: never a courier id, which is the actor's. */
export type CourierReport = Omit<DeliveryEventInput, 'courierId'>;

export interface ReportInput extends DeliveryRef {
  readonly report: CourierReport;
}

/**
 * A delivery assigned to the courier. Rule `permissions [delivery.assignment.view]`. A delivery
 * not assigned to this courier answers `delivery.not-found`.
 */
export class ViewAssignment extends UseCase<DeliveryRef, DeliveryState, DeliveryFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'delivery.view-assignment',
    rule: { kind: 'permissions', allOf: [ASSIGNMENT_VIEW.key] },
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
    const courierId = courierOf(context);
    if (courierId === null) return Promise.resolve(err(ACCESS_DENIED));
    return readDelivery(
      this.deps,
      context.market,
      input.deliveryId,
      (delivery) => delivery.courierId === courierId,
    );
  }
}

/**
 * The courier reports on its own assignment: arrival, pickup with the cold-chain reading,
 * delivery with proof, a failure with a reason, the return. Rule `permissions
 * [delivery.assignment.report]`. Only the courier the delivery is assigned to, and only the
 * events of {@link COURIER_EVENT_TYPES}: assigning and cancelling are a dispatcher's.
 */
export class ReportAssignmentEvent extends UseCase<ReportInput, DeliveryState, DeliveryFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'delivery.report-assignment-event',
    rule: { kind: 'permissions', allOf: [ASSIGNMENT_REPORT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: DeliveryAccessDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: ReportInput,
  ): Promise<Result<DeliveryState, DeliveryFailure>> {
    const courierId = courierOf(context);
    if (courierId === null) return Promise.resolve(err(ACCESS_DENIED));
    const { courierId: _ignored, ...report } = input.report as DeliveryEventInput;
    return recordEvent(
      this.deps,
      context.market,
      input.deliveryId,
      report,
      (delivery) => delivery.courierId === courierId,
      COURIER_EVENT_TYPES,
    );
  }
}
