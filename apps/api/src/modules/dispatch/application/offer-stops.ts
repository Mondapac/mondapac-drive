import { geoPoint, type GeoPoint } from '@mondapac-drive/shared-kernel';
import type { OfferArea, OfferStops } from '../domain/dispatch-job';
import type { DispatchSettings } from '../domain/dispatch-settings';
import type { DeliveryForDispatch, DeliveryStop } from './ports';

/** The longest suburb an offer shows (the column's width); a longer one is shown as unknown. */
const MAX_SUBURB_LENGTH = 200;
// Control, format and bidi characters never belong in a place name a courier reads.
const UNPRINTABLE = /[\p{Cc}\p{Cf}]/u;

/**
 * What an offer shows of the delivery before accept (security L3): the suburb and postcode of
 * both stops (never their addresses), the drop-off point snapped to the Market's grid, so it
 * names a street block rather than a house, and the quoted trip distance.
 */
export function stopsOf(
  delivery: DeliveryForDispatch,
  settings: Pick<DispatchSettings, 'offerPointDecimals'>,
): OfferStops {
  return {
    pickupArea: areaOf(delivery.pickup),
    dropoffArea: areaOf(delivery.dropoff),
    dropoff: coarsePoint(delivery.dropoff.point, settings.offerPointDecimals),
    tripDistanceMetres: delivery.distanceMetres,
  };
}

/**
 * The point rounded to `decimals` places: every point of one grid cell gives the same answer,
 * so repeated offers of nearby deliveries never narrow it down.
 */
export function coarsePoint(point: GeoPoint, decimals: number): GeoPoint {
  const scale = 10 ** decimals;
  const snap = (value: number) => Math.round(value * scale) / scale;
  return geoPoint(snap(point.lat), snap(point.lng));
}

function areaOf(stop: DeliveryStop): OfferArea {
  return { suburb: suburbOf(stop.suburb), postcode: stop.postcode };
}

/** The suburb as an offer shows it, or null when delivery has none or it is unusable. */
function suburbOf(raw: string | null | undefined): string | null {
  const suburb = raw?.trim();
  if (suburb === undefined || suburb === '') return null;
  if (suburb.length > MAX_SUBURB_LENGTH || UNPRINTABLE.test(suburb)) return null;
  return suburb;
}
