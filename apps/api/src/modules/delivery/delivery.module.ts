import { Module, type FactoryProvider } from '@nestjs/common';
import type { Clock, IdGenerator } from '@mondapac-drive/shared-kernel';
import { registerPermissions, USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { UNIT_OF_WORK, type UnitOfWork } from '../../platform/unit-of-work/unit-of-work';
import type { DeliveryAccessDependencies } from './application/deliveries';
import { DeliveryPricing } from './application/pricing';
import {
  DELIVERY_REPOSITORY,
  DISTANCE_PROVIDER,
  MARKET_SETTINGS,
  type DeliveryRepository,
  type DistanceProvider,
  type MarketSettingsProvider,
} from './application/ports';
import {
  CancelDelivery,
  DispatchDelivery,
  ViewDelivery,
} from './application/use-cases/admin-deliveries.use-case';
import { BookDelivery } from './application/use-cases/book-delivery.use-case';
import {
  ReportAssignmentEvent,
  ViewAssignment,
} from './application/use-cases/courier-deliveries.use-case';
import { CancelBooking, ViewBooking } from './application/use-cases/merchant-deliveries.use-case';
import { QuoteDelivery } from './application/use-cases/quote-delivery.use-case';
import { DELIVERY_PERMISSIONS } from './contracts/permissions';
import { deliveryProviders } from './infrastructure/delivery-providers';
import {
  AdminDeliveryController,
  CourierDeliveryController,
  MerchantDeliveryController,
} from './presentation/delivery.controller';

const pricingProvider: FactoryProvider<DeliveryPricing> = {
  provide: DeliveryPricing,
  inject: [MARKET_SETTINGS, DISTANCE_PROVIDER, CLOCK],
  useFactory: (markets: MarketSettingsProvider, distances: DistanceProvider, clock: Clock) =>
    new DeliveryPricing({ markets, distances, clock }),
};

/** The provider of a use case over one delivery: the gate and the delivery ports. */
function deliveryUseCase<U>(
  type: new (gate: UseCaseGate, deps: DeliveryAccessDependencies) => U,
): FactoryProvider<U> {
  return {
    provide: type,
    inject: [USE_CASE_GATE, DELIVERY_REPOSITORY, MARKET_SETTINGS, UNIT_OF_WORK, CLOCK],
    useFactory: (
      gate: UseCaseGate,
      deliveries: DeliveryRepository,
      markets: MarketSettingsProvider,
      unitOfWork: UnitOfWork,
      clock: Clock,
    ) => new type(gate, { deliveries, markets, unitOfWork, clock }),
  };
}

/**
 * Delivery: quote, book and follow a delivery through its lifecycle, with cold-chain readings
 * and proof of delivery. Deliveries are stored in PostgreSQL through the platform's unit of work.
 * Every entry goes through a use case behind the UseCaseGate: merchants (API keys) quote, book,
 * read and cancel their own deliveries; couriers read and report on their own assignments;
 * operators and dispatchers read, dispatch and cancel any delivery of the Market.
 */
@Module({
  controllers: [MerchantDeliveryController, CourierDeliveryController, AdminDeliveryController],
  providers: [
    registerPermissions('delivery', DELIVERY_PERMISSIONS),
    ...deliveryProviders,
    pricingProvider,
    {
      provide: QuoteDelivery,
      inject: [USE_CASE_GATE, DeliveryPricing],
      useFactory: (gate: UseCaseGate, pricing: DeliveryPricing) =>
        new QuoteDelivery(gate, { pricing }),
    },
    {
      provide: BookDelivery,
      inject: [
        USE_CASE_GATE,
        DeliveryPricing,
        DELIVERY_REPOSITORY,
        UNIT_OF_WORK,
        ID_GENERATOR,
        CLOCK,
      ],
      useFactory: (
        gate: UseCaseGate,
        pricing: DeliveryPricing,
        deliveries: DeliveryRepository,
        unitOfWork: UnitOfWork,
        ids: IdGenerator,
        clock: Clock,
      ) => new BookDelivery(gate, { pricing, deliveries, unitOfWork, ids, clock }),
    },
    deliveryUseCase(ViewBooking),
    deliveryUseCase(CancelBooking),
    deliveryUseCase(ViewAssignment),
    deliveryUseCase(ReportAssignmentEvent),
    deliveryUseCase(ViewDelivery),
    deliveryUseCase(DispatchDelivery),
    deliveryUseCase(CancelDelivery),
  ],
})
export class DeliveryModule {}
