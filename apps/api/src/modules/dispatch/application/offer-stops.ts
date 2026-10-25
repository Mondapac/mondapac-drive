import type { OfferArea, OfferStops } from '../domain/dispatch-job';
import type { DeliveryForDispatch, DeliveryStop } from './ports';

/**
 * What an offer shows of the delivery: the suburb and postcode of both stops (not their
 * addresses), the drop-off point and the trip distance.
 */
export function stopsOf(delivery: DeliveryForDispatch): OfferStops {
  return {
    pickupArea: areaOf(delivery.pickup),
    dropoffArea: areaOf(delivery.dropoff),
    dropoff: delivery.dropoff.point,
    tripDistanceMetres: delivery.distanceMetres,
  };
}

function areaOf(stop: DeliveryStop): OfferArea {
  const suburb = stop.suburb?.trim();
  return { suburb: suburb === undefined || suburb === '' ? null : suburb, postcode: stop.postcode };
}
