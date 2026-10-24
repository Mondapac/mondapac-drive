/** A WGS 84 point. */
export interface GeoPoint {
  readonly lat: number;
  readonly lng: number;
}

export function geoPoint(lat: number, lng: number): GeoPoint {
  if (!(lat >= -90 && lat <= 90) || !(lng >= -180 && lng <= 180)) {
    throw new RangeError(`Invalid coordinates (${lat}, ${lng})`);
  }
  return { lat, lng };
}
