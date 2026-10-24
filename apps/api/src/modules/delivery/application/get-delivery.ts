import { Inject, Injectable } from '@nestjs/common';
import { err, ok, type Id, type MarketContext, type Result } from '@mondapac-drive/shared-kernel';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { DeliveryState } from '../domain/delivery';
import type { DeliveryFailure } from './failure';

/** The refusals of every delivery use case, for the entry points that map them. */
export type { DeliveryFailure };
import { DELIVERY_REPOSITORY, type DeliveryRepository } from './ports';
import { notFound } from './record-delivery-event';

@Injectable()
export class GetDelivery {
  constructor(
    @Inject(DELIVERY_REPOSITORY) private readonly deliveries: DeliveryRepository,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
  ) {}

  execute(
    market: MarketContext,
    deliveryId: Id<'Delivery'>,
  ): Promise<Result<DeliveryState, DeliveryFailure>> {
    return this.unitOfWork.run(
      market,
      async () => {
        const delivery = await this.deliveries.findById(market, deliveryId);
        return delivery ? ok(delivery) : err(notFound(deliveryId));
      },
      { readOnly: true },
    );
  }
}
