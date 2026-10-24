import { Inject, Injectable } from '@nestjs/common';
import type { MarketId } from '@mondapac-drive/shared-kernel';
import type { DeliveryState } from '../domain/delivery.js';
import { DeliveryDomainError } from '../domain/errors.js';
import { DELIVERY_REPOSITORY, type DeliveryRepository } from './ports.js';

@Injectable()
export class GetDelivery {
  constructor(@Inject(DELIVERY_REPOSITORY) private readonly deliveries: DeliveryRepository) {}

  async execute(marketId: MarketId, deliveryId: string): Promise<DeliveryState> {
    const delivery = await this.deliveries.findById(marketId, deliveryId);
    if (!delivery) {
      throw new DeliveryDomainError('delivery.not-found', `No delivery ${deliveryId}`);
    }
    return delivery;
  }
}
