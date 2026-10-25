import type { CallContext, Money } from '@mondapac-drive/shared-kernel';
import type { EarningsQuote } from '../../payouts';
import type { OfferEarnings, OfferToPrice } from '../application/ports';

/**
 * {@link OfferEarnings} over payouts' public `EarningsQuote`: the same rates and payee profile
 * the earning subscriber uses, asked as the courier who holds the offer.
 */
export class PayoutsOfferEarnings implements OfferEarnings {
  constructor(private readonly quote: Pick<EarningsQuote, 'forOffer'>) {}

  forOffer(context: CallContext, offer: OfferToPrice): Promise<Money | null> {
    return this.quote.forOffer(context, offer);
  }
}
