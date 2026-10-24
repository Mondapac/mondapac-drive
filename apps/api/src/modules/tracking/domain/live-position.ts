import type { GeoPoint, Temporal } from '@mondapac-drive/shared-kernel';
import type { LocationPing } from './location-ping';

/** A courier's latest accepted position, kept only while it is fresh (live position TTL). */
export interface LivePosition {
  readonly courierId: string;
  readonly point: GeoPoint;
  readonly accuracyMetres: number;
  readonly headingDegrees?: number;
  readonly speedKmh?: number;
  readonly recordedAt: Temporal.Instant;
  readonly serviceAreaCode?: string;
}

/** A courier found near a point, nearest first. */
export interface NearbyCourier {
  readonly position: LivePosition;
  readonly distanceMetres: number;
}

export function livePositionOf(ping: LocationPing): LivePosition {
  return { ...ping };
}
