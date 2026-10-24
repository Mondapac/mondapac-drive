import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../platform/clock/clock.js';
import { ID_GENERATOR, type IdGenerator } from '../../../platform/ids/id-generator.js';
import { createDelivery, type DeliveryState, type Stop } from '../domain/delivery.js';
import { DeliveryDomainError } from '../domain/errors.js';
import { DELIVERY_REPOSITORY, type DeliveryRepository } from './ports.js';
import { QuoteDelivery, type QuoteDeliveryInput } from './quote-delivery.js';

export interface CreateDeliveryInput extends Omit<QuoteDeliveryInput, 'pickup' | 'dropoff'> {
  readonly merchantId: string;
  readonly externalReference: string;
  readonly pickup: Stop;
  readonly dropoff: Stop;
  /** The total the merchant accepted from a quote; booking fails if the price has changed. */
  readonly expectedTotal?: number;
}

/**
 * Books a delivery. Idempotent on (merchant, external reference): a retry returns the delivery
 * already booked instead of creating a second one.
 */
@Injectable()
export class CreateDelivery {
  constructor(
    private readonly quoteDelivery: QuoteDelivery,
    @Inject(DELIVERY_REPOSITORY) private readonly deliveries: DeliveryRepository,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(
    input: CreateDeliveryInput,
  ): Promise<{ delivery: DeliveryState; created: boolean }> {
    const existing = await this.deliveries.findByExternalReference(
      input.marketId,
      input.merchantId,
      input.externalReference,
    );
    if (existing) return { delivery: existing, created: false };

    const { quote, serviceArea } = await this.quoteDelivery.execute(input);
    if (input.expectedTotal !== undefined && input.expectedTotal !== quote.total.amount) {
      throw new DeliveryDomainError(
        'quote.price-changed',
        `The price is now ${quote.total.amount} ${quote.total.currency}; quote again`,
      );
    }

    const delivery = createDelivery({
      id: this.ids.next(),
      marketId: input.marketId,
      merchantId: input.merchantId,
      externalReference: input.externalReference,
      serviceAreaCode: serviceArea.code,
      pickup: input.pickup,
      dropoff: input.dropoff,
      parcel: input.parcel,
      mode: input.mode,
      window: input.window,
      quote,
      createdAt: this.clock.now(),
    });
    await this.deliveries.save(delivery);
    return { delivery, created: true };
  }
}
