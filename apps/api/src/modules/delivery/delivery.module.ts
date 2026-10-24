import { Module } from '@nestjs/common';
import { CreateDelivery } from './application/create-delivery.js';
import { GetDelivery } from './application/get-delivery.js';
import { DELIVERY_REPOSITORY, DISTANCE_PROVIDER } from './application/ports.js';
import { QuoteDelivery } from './application/quote-delivery.js';
import { RecordDeliveryEvent } from './application/record-delivery-event.js';
import { InMemoryDeliveryRepository } from './infrastructure/in-memory-delivery.repository.js';
import { StraightLineDistanceProvider } from './infrastructure/straight-line-distance.provider.js';
import { DeliveryController } from './presentation/delivery.controller.js';

@Module({
  controllers: [DeliveryController],
  providers: [
    QuoteDelivery,
    CreateDelivery,
    RecordDeliveryEvent,
    GetDelivery,
    { provide: DELIVERY_REPOSITORY, useClass: InMemoryDeliveryRepository },
    { provide: DISTANCE_PROVIDER, useValue: new StraightLineDistanceProvider() },
  ],
})
export class DeliveryModule {}
