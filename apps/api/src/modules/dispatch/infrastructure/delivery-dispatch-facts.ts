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
    const { window, ...rest } = delivery;
    return window === undefined ? rest : { ...rest, window };
  }
}
