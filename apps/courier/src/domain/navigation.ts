import type { GeoPoint } from '../api/schemas';

/** Where to go: the stop's point, or its address when the API has no point for it. */
export type Destination = GeoPoint | string;

function encode(destination: Destination): string {
  return typeof destination === 'string'
    ? encodeURIComponent(destination)
    : `${destination.lat},${destination.lng}`;
}

/**
 * A deep link that opens the device's map app with directions. The platform's own map app is
 * used, so no maps SDK or key is needed in the app.
 */
export function directionsUrl(destination: Destination, platform: string): string {
  const target = encode(destination);
  if (platform === 'ios') return `maps://?daddr=${target}&dirflg=d`;
  if (platform === 'android') return `google.navigation:q=${target}`;
  return webDirectionsUrl(destination);
}

/** The web fallback when no map app takes the deep link. */
export function webDirectionsUrl(destination: Destination): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${encode(destination)}`;
}
