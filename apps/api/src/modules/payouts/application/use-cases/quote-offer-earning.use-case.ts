import {
  addMoney,
  err,
  ok,
  type CallContext,
  type Money,
  type Result,
} from '@mondapac-drive/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { EARNINGS_VIEW } from '../../contracts/permissions';
import { earningFor } from '../../domain/earnings';
import { PayoutsDomainError } from '../../domain/errors';
import type { Temperature, VehicleType } from '../../domain/payout-settings';
import { payTaxOn } from '../../domain/tax';
import { courierOf } from '../callers';
import type { PayoutsDependencies } from '../dependencies';
import { ACCESS_DENIED, type PayoutsFailure } from '../failure';

/**
 * The delivery an offer is for, as dispatch holds it: the same facts delivery reports to the
 * earning subscriber (the vehicle the delivery was quoted for, its quoted distance and the
 * parcel's temperature), so the quote prices exactly what the earning will.
 */
export interface OfferToQuote {
  readonly deliveryId: string;
  readonly vehicle: VehicleType;
  readonly distanceMetres: number;
  readonly temperature: Temperature;
}

/**
 * What the signed-in courier will earn for an offered delivery if they take it and deliver it,
 * for the courier app's offer card: the earning `RecordDeliveryEarning` will record, from the
 * same Market rates and the same fleet payee profile, with the tax Drive adds on top (AU: GST
 * for a registered contractor), so it equals what lands in the courier's balance. Waiting time
 * is not known before the delivery, so none is quoted; the recorded earning may add it.
 *
 * Null when there is nothing to quote: an employee (paid through payroll), a courier fleet does
 * not know, a vehicle the Market has no courier rate for, or a fleet read that failed (the offer
 * still shows, without its pay). Called in process by dispatch's offer view, as the courier;
 * no route reaches it. Rule `permissions [payouts.earnings.view]`, couriers only: the courier is
 * the session's.
 */
export class EarningsQuote extends UseCase<OfferToQuote, Money | null, PayoutsFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'payouts.quote-offer-earning',
    rule: { kind: 'permissions', allOf: [EARNINGS_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PayoutsDependencies,
  ) {
    super(gate);
  }

  /** The quote, or null when there is none or the caller may not have one. */
  async forOffer(context: CallContext, offer: OfferToQuote): Promise<Money | null> {
    try {
      const quoted = await this.execute(context, offer);
      return quoted.ok ? quoted.value : null;
    } catch {
      // A fleet outage: the offer is still worth showing, without its pay.
      return null;
    }
  }

  protected async handle(
    context: CallContext,
    offer: OfferToQuote,
  ): Promise<Result<Money | null, PayoutsFailure>> {
    const courierId = courierOf(context);
    if (courierId === null) return err(ACCESS_DENIED);
    const { payees, settings: provider, clock } = this.deps;
    const payee = (await payees.payees(context, [courierId])).get(courierId);
    if (payee === undefined || payee.engagement === 'employee') return ok(null);
    const settings = provider.get(context.market.marketId);
    try {
      const earning = earningFor(settings, payee.engagement, {
        deliveryId: offer.deliveryId,
        courierId,
        vehicle: offer.vehicle,
        distanceMetres: offer.distanceMetres,
        temperature: offer.temperature,
        deliveredAt: clock.now(),
      });
      return ok(addMoney(earning.total, payTaxOn(settings, payee, 'service', earning.total)));
    } catch (error) {
      if (error instanceof PayoutsDomainError) return ok(null);
      throw error;
    }
  }
}
