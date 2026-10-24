import { Inject, Injectable } from '@nestjs/common';
import {
  err,
  ok,
  type Clock,
  type GeoPoint,
  type Id,
  type MarketContext,
  type Result,
} from '@mondapac-drive/shared-kernel';
import { CLOCK } from '../../../../platform/clock/clock.module';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { isCourierId } from '../../domain/location-ping';
import {
  startTracking,
  updateTracking,
  type TrackedDelivery,
  type TrackedStatus,
} from '../../domain/tracked-delivery';
import type { VehicleType } from '../../domain/vehicle';
import { failure, type TrackingFailure } from '../failure';
import { TRACKING_REPOSITORY, type TrackingRepository } from '../ports';

export interface TrackDeliveryInput {
  readonly deliveryId: Id<'Delivery'>;
  readonly status: TrackedStatus;
  readonly courierId?: string;
  readonly vehicle?: VehicleType;
  readonly pickup: GeoPoint;
  readonly dropoff: GeoPoint;
}

/**
 * Delivery and dispatch report a delivery's status and courier, so tracking knows whose pings
 * form its trail and what its customer link may show. The first report starts tracking; a
 * repeated report changes nothing; a report after the delivery ended is refused.
 */
@Injectable()
export class TrackDelivery {
  constructor(
    @Inject(TRACKING_REPOSITORY) private readonly tracking: TrackingRepository,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  perform(
    market: MarketContext,
    input: TrackDeliveryInput,
  ): Promise<Result<TrackedDelivery, TrackingFailure>> {
    if (input.courierId !== undefined && !isCourierId(input.courierId)) {
      return Promise.resolve(
        err(failure('tracking.invalid', 'The courier id is not valid', { field: 'courierId' })),
      );
    }
    const now = this.clock.now();
    return this.unitOfWork.run(market, async () => {
      const current = await this.tracking.findDelivery(market, input.deliveryId);
      if (current === undefined) {
        const started = startTracking(input, now);
        await this.tracking.saveDelivery(market, started);
        return ok(started);
      }
      const updated = updateTracking(current, input, now);
      if (!updated.ok) return err(failure(updated.error.code, 'The delivery has ended'));
      if (updated.value !== current) await this.tracking.saveDelivery(market, updated.value);
      return ok(updated.value);
    });
  }
}
