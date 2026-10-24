import { Inject, Injectable } from '@nestjs/common';
import {
  err,
  ok,
  type Clock,
  type Id,
  type MarketContext,
  type Result,
} from '@mondapac-drive/shared-kernel';
import { CLOCK } from '../../../platform/clock/clock.module';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import {
  applyDeliveryEvent,
  type DeliveryEventInput,
  type DeliveryState,
} from '../domain/delivery';
import { refusingBrokenRules, type DeliveryFailure } from './failure';
import {
  DELIVERY_REPOSITORY,
  MARKET_SETTINGS,
  type DeliveryRepository,
  type MarketSettingsProvider,
} from './ports';

/** Records what a courier, a dispatcher or the system reports about a delivery. */
@Injectable()
export class RecordDeliveryEvent {
  constructor(
    @Inject(DELIVERY_REPOSITORY) private readonly deliveries: DeliveryRepository,
    @Inject(MARKET_SETTINGS) private readonly markets: MarketSettingsProvider,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  execute(
    market: MarketContext,
    deliveryId: Id<'Delivery'>,
    event: DeliveryEventInput,
  ): Promise<Result<DeliveryState, DeliveryFailure>> {
    const settings = this.markets.get(market.marketId);
    return this.unitOfWork.run(market, () =>
      refusingBrokenRules(async () => {
        const delivery = await this.deliveries.findById(market, deliveryId);
        if (!delivery) return err(notFound(deliveryId));
        const next = applyDeliveryEvent(delivery, event, this.clock.now(), settings);
        await this.deliveries.update(market, next);
        return ok(next);
      }),
    );
  }
}

export function notFound(id: string): DeliveryFailure {
  return { code: 'delivery.not-found', message: `No delivery ${id}` };
}
