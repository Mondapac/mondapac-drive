import type { OfferStops } from '../domain/dispatch-job';
import type { DeliveryForDispatch } from './ports';

/** What an offer shows of the delivery: both addresses, the drop-off point, the trip distance. */
export function stopsOf(delivery: DeliveryForDispatch): OfferStops {
  return {
    pickupAddress: delivery.pickup.address,
    dropoffAddress: delivery.dropoff.address,
    dropoff: delivery.dropoff.point,
    tripDistanceMetres: delivery.distanceMetres,
  };
}
