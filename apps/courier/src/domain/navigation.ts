import type { GeoPoint } from '../api/schemas';

/**
 * A deep link that opens the device's map app with directions to a point. The platform's own
 * map app is used, so no maps SDK or key is needed in the app.
 */
export function directionsUrl(point: GeoPoint, platform: string): string {
  const destination = `${point.lat},${point.lng}`;
  if (platform === 'ios') return `maps://?daddr=${destination}&dirflg=d`;
  if (platform === 'android') return `google.navigation:q=${destination}`;
  return `https://www.google.com/maps/dir/?api=1&destination=${destination}`;
}

/** The web fallback when no map app takes the deep link. */
export function webDirectionsUrl(point: GeoPoint): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${point.lat},${point.lng}`;
}
