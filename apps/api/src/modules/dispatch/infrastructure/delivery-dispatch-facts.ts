import type { DeliveryFacts, DeliveryForDispatch } from '../application/ports';

/**
 * Stand-in for the {@link DeliveryFacts} over delivery's `DeliveryDispatchView` (wave 2,
 * handoff 21), which is not on main yet: it knows no delivery, so the booking subscriber
 * retries until the real binding replaces it before this module's routes merge.
 */
export class PendingDeliveryFacts implements DeliveryFacts {
  forDispatch(): Promise<DeliveryForDispatch | undefined> {
    return Promise.resolve(undefined);
  }
}
