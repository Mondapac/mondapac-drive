import type { LocationPing } from '../api/schemas';

/** The fields of an expo-location fix that a ping uses. */
export interface LocationFix {
  readonly timestamp: number;
  readonly coords: {
    readonly latitude: number;
    readonly longitude: number;
    readonly accuracy: number | null;
    readonly heading: number | null;
    readonly speed: number | null;
  };
}

/** At most this many fixes go in one request; older ones of a burst are dropped. */
export const MAX_PINGS_PER_BATCH = 20;

/**
 * Turns location fixes into tracking pings (handoff 06). A fix without accuracy is dropped, and
 * so are a negative speed or heading, which the platforms report when they are unknown.
 */
export function toPings(courierId: string, fixes: readonly LocationFix[]): LocationPing[] {
  return fixes
    .filter((fix) => fix.coords.accuracy !== null && fix.coords.accuracy >= 0)
    .slice(-MAX_PINGS_PER_BATCH)
    .map((fix) => {
      const { latitude, longitude, accuracy, heading, speed } = fix.coords;
      return {
        courierId,
        lat: latitude,
        lng: longitude,
        accuracyM: Math.round(accuracy ?? 0),
        ...(heading !== null && heading >= 0 ? { headingDeg: Math.round(heading) % 360 } : {}),
        ...(speed !== null && speed >= 0 ? { speedKmh: Math.round(speed * 3.6 * 10) / 10 } : {}),
        recordedAt: new Date(fix.timestamp).toISOString(),
      };
    });
}
