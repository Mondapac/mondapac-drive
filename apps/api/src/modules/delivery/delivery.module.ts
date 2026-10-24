import { Module } from '@nestjs/common';
import { CreateDelivery } from './application/create-delivery';
import { GetDelivery } from './application/get-delivery';
import { QuoteDelivery } from './application/quote-delivery';
import { RecordDeliveryEvent } from './application/record-delivery-event';
import { deliveryProviders } from './infrastructure/delivery-providers';
import { DeliveryController } from './presentation/delivery.controller';

/**
 * Delivery: quote, book and follow a delivery through its lifecycle, with cold-chain readings
 * and proof of delivery. Deliveries are stored in PostgreSQL through the platform's unit of work.
 */
@Module({
  controllers: [DeliveryController],
  providers: [
    QuoteDelivery,
    CreateDelivery,
    RecordDeliveryEvent,
    GetDelivery,
    ...deliveryProviders,
  ],
})
export class DeliveryModule {}
