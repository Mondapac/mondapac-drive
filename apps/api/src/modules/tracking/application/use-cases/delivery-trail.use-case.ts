import { Inject, Injectable } from '@nestjs/common';
import { err, ok, type Id, type MarketContext, type Result } from '@mondapac-drive/shared-kernel';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { Breadcrumb } from '../../domain/breadcrumb';
import { deliveryNotTracked, type TrackingFailure } from '../failure';
import { TRACKING_REPOSITORY, type TrackingRepository } from '../ports';

/** The most points one trail read returns. */
export const MAX_TRAIL_POINTS = 5000;

/** A delivery's breadcrumb trail, for the dispatcher (and proof-of-route questions). */
@Injectable()
export class DeliveryTrail {
  constructor(
    @Inject(TRACKING_REPOSITORY) private readonly tracking: TrackingRepository,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
  ) {}

  perform(
    market: MarketContext,
    deliveryId: Id<'Delivery'>,
  ): Promise<Result<Breadcrumb[], TrackingFailure>> {
    return this.unitOfWork.run(
      market,
      async () => {
        const delivery = await this.tracking.findDelivery(market, deliveryId);
        if (delivery === undefined) return err(deliveryNotTracked());
        return ok(await this.tracking.trailOf(market, deliveryId, MAX_TRAIL_POINTS));
      },
      { readOnly: true },
    );
  }
}
