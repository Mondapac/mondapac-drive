import { Inject, Injectable } from '@nestjs/common';
import {
  err,
  ok,
  type Clock,
  type IdGenerator,
  type MarketContext,
  type Result,
} from '@mondapac-drive/shared-kernel';
import { CLOCK } from '../../../platform/clock/clock.module';
import { ID_GENERATOR } from '../../../platform/ids/ids.module';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import { createDelivery, type DeliveryState, type Stop } from '../domain/delivery';
import { refusingBrokenRules, type DeliveryFailure } from './failure';
import { DELIVERY_REPOSITORY, type DeliveryRepository } from './ports';
import { QuoteDelivery, type QuoteDeliveryInput } from './quote-delivery';

export interface CreateDeliveryInput extends Omit<QuoteDeliveryInput, 'pickup' | 'dropoff'> {
  readonly merchantId: string;
  readonly externalReference: string;
  readonly pickup: Stop;
  readonly dropoff: Stop;
  /** The total the merchant accepted from a quote; booking fails if the price has changed. */
  readonly expectedTotal?: bigint;
}

export interface CreatedDelivery {
  readonly delivery: DeliveryState;
  readonly created: boolean;
}

/**
 * Books a delivery. Idempotent on (merchant, external reference): a retry, also one that races
 * the first request, returns the delivery already booked instead of creating a second one.
 */
@Injectable()
export class CreateDelivery {
  constructor(
    private readonly quoteDelivery: QuoteDelivery,
    @Inject(DELIVERY_REPOSITORY) private readonly deliveries: DeliveryRepository,
    @Inject(UNIT_OF_WORK) private readonly unitOfWork: UnitOfWork,
    @Inject(ID_GENERATOR) private readonly ids: IdGenerator,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(
    market: MarketContext,
    input: CreateDeliveryInput,
  ): Promise<Result<CreatedDelivery, DeliveryFailure>> {
    const booked = await this.booked(market, input);
    if (booked !== undefined) return ok({ delivery: booked, created: false });

    // Pricing reads no row, so it runs before the unit (marketplace persistence design 3.4).
    const quoted = await this.quoteDelivery.execute(market, input);
    if (!quoted.ok) return quoted;
    const { quote, serviceArea } = quoted.value;
    if (input.expectedTotal !== undefined && input.expectedTotal !== quote.total.amount) {
      return err({
        code: 'quote.price-changed',
        message: `The price is now ${quote.total.amount} ${quote.total.currency}; quote again`,
      });
    }

    return refusingBrokenRules(async () => {
      const delivery = createDelivery({
        id: this.ids.next<'Delivery'>(),
        marketId: market.marketId,
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
      return this.unitOfWork.run(
        market,
        async (): Promise<Result<CreatedDelivery, DeliveryFailure>> => {
          if (await this.deliveries.insert(market, delivery)) {
            return ok({ delivery, created: true });
          }
          // The same reference was booked meanwhile: answer with that delivery.
          const existing = await this.deliveries.findByExternalReference(
            market,
            input.merchantId,
            input.externalReference,
          );
          return existing
            ? ok({ delivery: existing, created: false })
            : err({
                code: 'delivery.conflict',
                message: 'The delivery could not be booked; retry',
              });
        },
      );
    });
  }

  private async booked(
    market: MarketContext,
    input: CreateDeliveryInput,
  ): Promise<DeliveryState | undefined> {
    const found = await this.unitOfWork.run(
      market,
      async () =>
        ok(
          await this.deliveries.findByExternalReference(
            market,
            input.merchantId,
            input.externalReference,
          ),
        ),
      { readOnly: true },
    );
    return found.ok ? found.value : undefined;
  }
}
