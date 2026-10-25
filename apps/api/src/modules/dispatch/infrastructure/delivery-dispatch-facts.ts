import type { CallContext, Id } from '@mondapac-drive/shared-kernel';
import type { DeliveryDispatchView } from '../../delivery';
import type { DeliveryFacts, DeliveryForDispatch } from '../application/ports';

/**
 * Dispatch's {@link DeliveryFacts} over delivery's `DeliveryDispatchView`, a `system` read: only
 * the event subscribers call it, with the system context the dispatcher minted.
 */
export class DeliveryDispatchFacts implements DeliveryFacts {
  constructor(private readonly view: DeliveryDispatchView) {}

  async forDispatch(
    context: CallContext,
    deliveryId: Id<'Delivery'>,
  ): Promise<DeliveryForDispatch | undefined> {
    const delivery = await this.view.forDispatch(context, deliveryId);
    if (delivery === undefined) return undefined;
    // Each stop without its street address: dispatch never holds one (security L3).
    const stop = (s: typeof delivery.pickup & { readonly suburb?: string | null }) => ({
      suburb: s.suburb ?? null,
      postcode: s.postcode,
      point: s.point,
    });
    const { window, pickup, dropoff, ...rest } = delivery;
    const found = { ...rest, pickup: stop(pickup), dropoff: stop(dropoff) };
    return window === undefined ? found : { ...found, window };
  }
}
