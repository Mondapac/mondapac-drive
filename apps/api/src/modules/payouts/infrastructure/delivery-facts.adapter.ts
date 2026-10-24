import type { CallContext, Id } from '@mondapac-drive/shared-kernel';
import type { DeliveryDispatchView } from '../../delivery';
import type { DeliveryFacts, DeliveryFactsReader } from '../application/ports';

/**
 * {@link DeliveryFactsReader} over delivery's public system read (handoff 21): the vehicle,
 * distance and parcel temperature a courier's earning is computed from. The call context is the
 * subscriber's system context; delivery's gate refuses any other actor.
 */
export class DeliveryModuleFacts implements DeliveryFactsReader {
  constructor(private readonly view: DeliveryDispatchView) {}

  async factsOf(context: CallContext, deliveryId: string): Promise<DeliveryFacts | undefined> {
    const delivery = await this.view.forDispatch(context, deliveryId as Id<'Delivery'>);
    if (delivery === undefined) return undefined;
    return {
      vehicle: delivery.vehicle,
      distanceMetres: delivery.distanceMetres,
      temperature: delivery.temperature,
    };
  }
}
