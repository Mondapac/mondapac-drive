import type { GeoPoint } from '@mondapac-drive/shared-kernel';

const EARTH_RADIUS_METRES = 6_371_008.8;
const radians = (degrees: number): number => (degrees * Math.PI) / 180;

/** Great-circle (haversine) distance between two points, in whole metres. */
export function straightLineMetres(from: GeoPoint, to: GeoPoint): number {
  const dLat = radians(to.lat - from.lat);
  const dLng = radians(to.lng - from.lng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(from.lat)) * Math.cos(radians(to.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_METRES * Math.asin(Math.min(1, Math.sqrt(a))));
}
