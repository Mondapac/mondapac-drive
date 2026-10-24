import {
  err,
  ok,
  type CallContext,
  type Clock,
  type GeoPoint,
  type Id,
  type Result,
} from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { isCourierId } from '../../domain/location-ping';
import {
  startTracking,
  updateTracking,
  type TrackedDelivery,
  type TrackedStatus,
} from '../../domain/tracked-delivery';
import type { VehicleType } from '../../domain/vehicle';
import { ACCESS_DENIED, isSystem } from '../callers';
import { failure, type TrackingFailure } from '../failure';
import type { TrackingRepository } from '../ports';

export interface TrackDeliveryInput {
  readonly deliveryId: Id<'Delivery'>;
  readonly status: TrackedStatus;
  /** The assigned courier's account id. */
  readonly courierId?: string;
  readonly vehicle?: VehicleType;
  readonly pickup: GeoPoint;
  readonly dropoff: GeoPoint;
}

export interface TrackDeliveryDependencies {
  readonly tracking: TrackingRepository;
  readonly unitOfWork: UnitOfWork;
  readonly clock: Clock;
}

/**
 * Delivery and dispatch report a delivery's status and courier, from their event subscribers,
 * so tracking knows whose pings form its trail and what its customer link may show. The first
 * report starts tracking; a repeated report changes nothing; a report after the delivery ended
 * is refused. Rule `system`.
 */
export class TrackDelivery extends UseCase<TrackDeliveryInput, TrackedDelivery, TrackingFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'tracking.track-delivery',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: TrackDeliveryDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: TrackDeliveryInput,
  ): Promise<Result<TrackedDelivery, TrackingFailure>> {
    if (!isSystem(context)) return Promise.resolve(err(ACCESS_DENIED));
    if (input.courierId !== undefined && !isCourierId(input.courierId)) {
      return Promise.resolve(
        err(failure('tracking.invalid', 'The courier id is not valid', { field: 'courierId' })),
      );
    }
    const { market } = context;
    const { tracking, unitOfWork, clock } = this.deps;
    const now = clock.now();
    return unitOfWork.run(market, async () => {
      const current = await tracking.findDelivery(market, input.deliveryId);
      if (current === undefined) {
        const started = startTracking(input, now);
        await tracking.saveDelivery(market, started);
        return ok(started);
      }
      const updated = updateTracking(current, input, now);
      if (!updated.ok) return err(failure(updated.error.code, 'The delivery has ended'));
      if (updated.value !== current) await tracking.saveDelivery(market, updated.value);
      return ok(updated.value);
    });
  }
}
