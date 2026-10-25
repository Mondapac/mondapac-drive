import { err, ok } from '@mondapac-drive/shared-kernel';
import type {
  CallContext,
  Clock,
  Id,
  IdGenerator,
  MarketContext,
  Result,
} from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { BOOKING_CREATE } from '../../contracts/permissions';
import { createDelivery, type DeliveryState, type Stop } from '../../domain/delivery';
import { bookedEvent } from '../../domain/events/delivery-events';
import { ACCESS_DENIED, merchantOf } from '../deliveries';
import { refusingBrokenRules, type DeliveryFailure } from '../failure';
import type { DeliveryPricing, QuoteDeliveryInput } from '../pricing';
import type { DeliveryRepository } from '../ports';

/** A stop as booked: its point may be left out, then it is geocoded from the address. */
export type BookedStop = Omit<Stop, 'point' | 'suburb'> & { readonly point?: Stop['point'] };

export interface BookDeliveryInput extends Omit<QuoteDeliveryInput, 'pickup' | 'dropoff'> {
  readonly externalReference: string;
  readonly pickup: BookedStop;
  readonly dropoff: BookedStop;
  /** The total the merchant accepted from a quote; booking fails if the price has changed. */
  readonly expectedTotal?: bigint;
}

/** The stop as stored: the request's, at its point, with the geocoder's suburb if any. */
function stopOf(stop: BookedStop, point: Stop['point'], suburb: string | undefined): Stop {
  return { ...stop, point, ...(suburb === undefined ? {} : { suburb }) };
}

export interface BookedDelivery {
  readonly delivery: DeliveryState;
  readonly created: boolean;
}

export interface BookDeliveryDependencies {
  readonly pricing: DeliveryPricing;
  readonly deliveries: DeliveryRepository;
  readonly unitOfWork: UnitOfWork;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly outbox: OutboxWriter;
}

/**
 * Books a delivery for the merchant of the API key. Rule `permissions [delivery.booking.create]`.
 * The merchant is the actor's, never a field of the request, so a key books only for its own
 * merchant. Idempotent on (merchant, external reference): a retry, also one that races the first
 * request, returns the delivery already booked instead of creating a second one. A new booking
 * writes `delivery.booked.v1` in the unit of the insert; a repeated one writes nothing.
 */
export class BookDelivery extends UseCase<BookDeliveryInput, BookedDelivery, DeliveryFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'delivery.book-delivery',
    rule: { kind: 'permissions', allOf: [BOOKING_CREATE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: BookDeliveryDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: BookDeliveryInput,
  ): Promise<Result<BookedDelivery, DeliveryFailure>> {
    const merchantId = merchantOf(context);
    if (merchantId === null) return err(ACCESS_DENIED);
    const { market } = context;
    const booked = await this.booked(market, merchantId, input.externalReference);
    if (booked !== undefined) return ok({ delivery: booked, created: false });

    // Pricing reads no row, so it runs before the unit (marketplace persistence design 3.4).
    const quoted = await this.deps.pricing.price(market, input, merchantId);
    if (!quoted.ok) return quoted;
    const { quote, serviceArea, pickupPoint, dropoffPoint, pickupSuburb, dropoffSuburb } =
      quoted.value;
    if (input.expectedTotal !== undefined && input.expectedTotal !== quote.total.amount) {
      return err({
        code: 'quote.price-changed',
        message: `The price is now ${quote.total.amount} ${quote.total.currency}; quote again`,
      });
    }

    return refusingBrokenRules(async () => {
      const delivery = createDelivery({
        id: this.deps.ids.next<'Delivery'>(),
        marketId: market.marketId,
        merchantId,
        externalReference: input.externalReference,
        serviceAreaCode: serviceArea.code,
        pickup: stopOf(input.pickup, pickupPoint, pickupSuburb),
        dropoff: stopOf(input.dropoff, dropoffPoint, dropoffSuburb),
        parcel: input.parcel,
        mode: input.mode,
        window: input.window,
        quote,
        createdAt: this.deps.clock.now(),
      });
      return this.deps.unitOfWork.run(
        market,
        async (): Promise<Result<BookedDelivery, DeliveryFailure>> => {
          if (await this.deps.deliveries.insert(market, delivery)) {
            await this.deps.outbox.append(context, [bookedEvent(delivery)]);
            return ok({ delivery, created: true });
          }
          // The same reference was booked meanwhile: answer with that delivery.
          const existing = await this.deps.deliveries.findByExternalReference(
            market,
            merchantId,
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
    merchantId: Id<'Merchant'>,
    externalReference: string,
  ): Promise<DeliveryState | undefined> {
    const found = await this.deps.unitOfWork.run(
      market,
      async () =>
        ok(
          await this.deps.deliveries.findByExternalReference(market, merchantId, externalReference),
        ),
      { readOnly: true },
    );
    return found.ok ? found.value : undefined;
  }
}
