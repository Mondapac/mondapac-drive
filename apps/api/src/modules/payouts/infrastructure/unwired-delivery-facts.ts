import type { DeliveryFactsReader } from '../application/ports';

/**
 * The delivery reader until delivery's public reads (work package 21) are on main: it knows no
 * delivery, so no earning is recorded from it. Replaced by an adapter over delivery's index.
 */
export class UnwiredDeliveryFacts implements DeliveryFactsReader {
  factsOf() {
    return Promise.resolve(undefined);
  }
}
