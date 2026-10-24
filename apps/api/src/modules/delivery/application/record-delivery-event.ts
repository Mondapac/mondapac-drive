import { Inject, Injectable } from '@nestjs/common';
import type { MarketId } from '@mondapac-drive/shared-kernel';
import { CLOCK, type Clock } from '../../../platform/clock/clock.js';
import {
  applyDeliveryEvent,
  type DeliveryEventInput,
  type DeliveryState,
} from '../domain/delivery.js';
import { DeliveryDomainError } from '../domain/errors.js';
import {
  DELIVERY_REPOSITORY,
  MARKET_SETTINGS,
  type DeliveryRepository,
  type MarketSettingsProvider,
} from './ports.js';

@Injectable()
export class RecordDeliveryEvent {
  constructor(
    @Inject(DELIVERY_REPOSITORY) private readonly deliveries: DeliveryRepository,
    @Inject(MARKET_SETTINGS) private readonly markets: MarketSettingsProvider,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(
    marketId: MarketId,
    deliveryId: string,
    event: DeliveryEventInput,
  ): Promise<DeliveryState> {
    const settings = this.markets.get(marketId);
    const delivery = await this.deliveries.findById(marketId, deliveryId);
    if (!delivery) {
      throw new DeliveryDomainError('delivery.not-found', `No delivery ${deliveryId}`);
    }
    const next = applyDeliveryEvent(delivery, event, this.clock.now(), settings);
    await this.deliveries.save(next);
    return next;
  }
}
