import { Module, type FactoryProvider } from '@nestjs/common';
import { IdentityModule } from '../identity';
import type { Clock, IdGenerator } from '@mondapac-drive/shared-kernel';
import { registerPermissions, USE_CASE_GATE, type UseCaseGate } from '../../platform/authz';
import { CLOCK } from '../../platform/clock/clock.module';
import { registerEvents } from '../../platform/events/event-catalogue';
import { registerSubscriptionsFrom } from '../../platform/events/event-subscriptions';
import { OUTBOX_WRITER, type OutboxWriter } from '../../platform/events/outbox-writer';
import { PersistenceModule } from '../../platform/persistence/persistence.module';
import { ID_GENERATOR } from '../../platform/ids/ids.module';
import { OBJECT_STORE, type ObjectStore } from '../../platform/storage/object-store';
import { UNIT_OF_WORK, type UnitOfWork } from '../../platform/unit-of-work/unit-of-work';
import type { DeliveryAccessDependencies } from './application/deliveries';
import { DeliveryPricing } from './application/pricing';
import {
  COURIER_ACCOUNTS,
  DELIVERY_REPOSITORY,
  DISTANCE_PROVIDER,
  GEOCODER,
  MARKET_SETTINGS,
  PROOF_PHOTOS,
  RECIPIENT_PINS,
  type CourierAccounts,
  type DeliveryRepository,
  type DistanceProvider,
  type Geocoder,
  type MarketSettingsProvider,
  type ProofPhotoRepository,
  type RecipientPins,
} from './application/ports';
import { UploadProofPhoto } from './application/use-cases/upload-proof-photo.use-case';
import {
  CancelDelivery,
  DispatchDelivery,
  ListDeliveries,
  ViewDelivery,
} from './application/use-cases/admin-deliveries.use-case';
import { BookDelivery } from './application/use-cases/book-delivery.use-case';
import {
  ReportAssignmentEvent,
  ViewAssignment,
} from './application/use-cases/courier-deliveries.use-case';
import {
  RecordDispatchAssignment,
  RecordDispatchExhausted,
} from './application/use-cases/dispatch-link.use-case';
import { CancelBooking, ViewBooking } from './application/use-cases/merchant-deliveries.use-case';
import { QuoteDelivery } from './application/use-cases/quote-delivery.use-case';
import {
  DeliveryDispatchView,
  DeliveryRecipients,
  DeliveryReferences,
} from './application/use-cases/system-reads.use-case';
import { DELIVERY_PERMISSIONS } from './contracts/permissions';
import { DELIVERY_EVENTS } from './domain/events/delivery-events';
import { deliveryProviders } from './infrastructure/delivery-providers';
import {
  AdminDeliveryController,
  CourierDeliveryController,
  MerchantDeliveryController,
} from './presentation/delivery.controller';
import { dispatchSubscriptions } from './presentation/subscribers/dispatch.subscriptions';

const pricingProvider: FactoryProvider<DeliveryPricing> = {
  provide: DeliveryPricing,
  inject: [MARKET_SETTINGS, DISTANCE_PROVIDER, GEOCODER, CLOCK],
  useFactory: (
    markets: MarketSettingsProvider,
    distances: DistanceProvider,
    geocoder: Geocoder,
    clock: Clock,
  ) => new DeliveryPricing({ markets, distances, geocoder, clock }),
};

/** What every use case over one delivery is built with, in its constructor's order. */
const DELIVERY_DEPENDENCIES = [
  USE_CASE_GATE,
  DELIVERY_REPOSITORY,
  MARKET_SETTINGS,
  UNIT_OF_WORK,
  CLOCK,
  OUTBOX_WRITER,
] as const;

/** The provider of a use case over one delivery: the gate and the delivery ports. */
function deliveryUseCase<U>(
  type: new (gate: UseCaseGate, deps: DeliveryAccessDependencies) => U,
): FactoryProvider<U> {
  return {
    provide: type,
    inject: [...DELIVERY_DEPENDENCIES],
    useFactory: (
      gate: UseCaseGate,
      deliveries: DeliveryRepository,
      markets: MarketSettingsProvider,
      unitOfWork: UnitOfWork,
      clock: Clock,
      outbox: OutboxWriter,
    ) => new type(gate, { deliveries, markets, unitOfWork, clock, outbox }),
  };
}

/**
 * Delivery: quote, book and follow a delivery through its lifecycle, with cold-chain readings
 * and proof of delivery. Deliveries are stored in PostgreSQL through the platform's unit of work.
 * Every entry goes through a use case behind the UseCaseGate: merchants (API keys) quote, book,
 * read and cancel their own deliveries; couriers read and report on their own assignments;
 * operators and dispatchers read, dispatch and cancel any delivery of the Market. Every change
 * writes its `delivery.*` event into the delivery outbox in the same unit; dispatch's assignments
 * and exhausted jobs come back through the subscriptions; dispatch and notifications read a
 * delivery through the `system` reads exported below.
 */
@Module({
  imports: [IdentityModule],
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
        OUTBOX_WRITER,
      ],
      useFactory: (
        gate: UseCaseGate,
        pricing: DeliveryPricing,
        deliveries: DeliveryRepository,
        unitOfWork: UnitOfWork,
        ids: IdGenerator,
        clock: Clock,
        outbox: OutboxWriter,
      ) => new BookDelivery(gate, { pricing, deliveries, unitOfWork, ids, clock, outbox }),
    },
    deliveryUseCase(ViewBooking),
    deliveryUseCase(CancelBooking),
    deliveryUseCase(ViewAssignment),
    {
      provide: ReportAssignmentEvent,
      inject: [...DELIVERY_DEPENDENCIES, RECIPIENT_PINS, PROOF_PHOTOS],
      useFactory: (
        gate: UseCaseGate,
        deliveries: DeliveryRepository,
        markets: MarketSettingsProvider,
        unitOfWork: UnitOfWork,
        clock: Clock,
        outbox: OutboxWriter,
        pins: RecipientPins,
        photos: ProofPhotoRepository,
      ) =>
        new ReportAssignmentEvent(gate, {
          deliveries,
          markets,
          unitOfWork,
          clock,
          outbox,
          pins,
          photos,
        }),
    },
    {
      provide: UploadProofPhoto,
      inject: [...DELIVERY_DEPENDENCIES, PROOF_PHOTOS, OBJECT_STORE, ID_GENERATOR],
      useFactory: (
        gate: UseCaseGate,
        deliveries: DeliveryRepository,
        markets: MarketSettingsProvider,
        unitOfWork: UnitOfWork,
        clock: Clock,
        outbox: OutboxWriter,
        photos: ProofPhotoRepository,
        files: ObjectStore,
        ids: IdGenerator,
      ) =>
        new UploadProofPhoto(gate, {
          deliveries,
          markets,
          unitOfWork,
          clock,
          outbox,
          photos,
          files,
          ids,
        }),
    },
    deliveryUseCase(ListDeliveries),
    deliveryUseCase(ViewDelivery),
    {
      provide: DispatchDelivery,
      inject: [
        USE_CASE_GATE,
        DELIVERY_REPOSITORY,
        MARKET_SETTINGS,
        UNIT_OF_WORK,
        CLOCK,
        OUTBOX_WRITER,
        COURIER_ACCOUNTS,
      ],
      useFactory: (
        gate: UseCaseGate,
        deliveries: DeliveryRepository,
        markets: MarketSettingsProvider,
        unitOfWork: UnitOfWork,
        clock: Clock,
        outbox: OutboxWriter,
        couriers: CourierAccounts,
      ) => new DispatchDelivery(gate, { deliveries, markets, unitOfWork, clock, outbox, couriers }),
    },
    deliveryUseCase(CancelDelivery),
    deliveryUseCase(RecordDispatchAssignment),
    deliveryUseCase(RecordDispatchExhausted),
    deliveryUseCase(DeliveryDispatchView),
    deliveryUseCase(DeliveryReferences),
    {
      provide: DeliveryRecipients,
      inject: [...DELIVERY_DEPENDENCIES, RECIPIENT_PINS],
      useFactory: (
        gate: UseCaseGate,
        deliveries: DeliveryRepository,
        markets: MarketSettingsProvider,
        unitOfWork: UnitOfWork,
        clock: Clock,
        outbox: OutboxWriter,
        pins: RecipientPins,
      ) => new DeliveryRecipients(gate, { deliveries, markets, unitOfWork, clock, outbox, pins }),
    },
    PersistenceModule.outboxWriterFor('delivery'),
    registerEvents('delivery', DELIVERY_EVENTS),
    registerSubscriptionsFrom(
      'delivery',
      [RecordDispatchAssignment, RecordDispatchExhausted],
      (assignment: RecordDispatchAssignment, exhausted: RecordDispatchExhausted) =>
        dispatchSubscriptions(assignment, exhausted),
    ),
  ],
  exports: [DeliveryDispatchView, DeliveryRecipients, DeliveryReferences],
})
export class DeliveryModule {}
