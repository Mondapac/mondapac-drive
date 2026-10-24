import { err, ok, Temporal, type GeoPoint, type Result } from '@mondapac-drive/shared-kernel';
import type { TrackingSettings } from './tracking-settings';

/** A courier id as other modules hand it over: an opaque id, at most 64 characters. */
const COURIER_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isCourierId(value: string): boolean {
  return COURIER_ID.test(value);
}

/** One location reading from a courier's device. */
export interface LocationPing {
  readonly courierId: string;
  readonly point: GeoPoint;
  readonly accuracyMetres: number;
  readonly headingDegrees?: number;
  readonly speedKmh?: number;
  /** When the device took the reading, not when it arrived. */
  readonly recordedAt: Temporal.Instant;
  /** The service area the courier works in, when their shift names one. */
  readonly serviceAreaCode?: string;
}

/** Why a ping was refused. Never carries the coordinates. */
export type PingRefusal =
  | { readonly code: 'ping.invalid'; readonly field: string }
  | { readonly code: 'ping.stale' }
  | { readonly code: 'ping.future' };

const SERVICE_AREA = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Checks a ping against the Market's rules, with `now` from the injected Clock: coordinates on
 * the globe, an accuracy the Market accepts, a heading of 0 to 360 degrees, a plausible speed,
 * and a reading neither older than `maxAgeSeconds` nor further ahead than the allowed skew.
 */
export function checkPing(
  settings: TrackingSettings,
  ping: LocationPing,
  now: Temporal.Instant,
): Result<LocationPing, PingRefusal> {
  const { lat, lng } = ping.point;
  if (!isCourierId(ping.courierId)) return err({ code: 'ping.invalid', field: 'courierId' });
  if (!(Number.isFinite(lat) && lat >= -90 && lat <= 90)) {
    return err({ code: 'ping.invalid', field: 'lat' });
  }
  if (!(Number.isFinite(lng) && lng >= -180 && lng <= 180)) {
    return err({ code: 'ping.invalid', field: 'lng' });
  }
  if (
    !Number.isFinite(ping.accuracyMetres) ||
    ping.accuracyMetres < 0 ||
    ping.accuracyMetres > settings.ping.maxAccuracyMetres
  ) {
    return err({ code: 'ping.invalid', field: 'accuracyM' });
  }
  if (
    ping.headingDegrees !== undefined &&
    !(Number.isFinite(ping.headingDegrees) && ping.headingDegrees >= 0 && ping.headingDegrees < 360)
  ) {
    return err({ code: 'ping.invalid', field: 'headingDeg' });
  }
  if (
    ping.speedKmh !== undefined &&
    !(
      Number.isFinite(ping.speedKmh) &&
      ping.speedKmh >= 0 &&
      ping.speedKmh <= settings.ping.maxSpeedKmh
    )
  ) {
    return err({ code: 'ping.invalid', field: 'speedKmh' });
  }
  if (ping.serviceAreaCode !== undefined && !SERVICE_AREA.test(ping.serviceAreaCode)) {
    return err({ code: 'ping.invalid', field: 'serviceArea' });
  }
  const oldest = now.subtract({ seconds: settings.ping.maxAgeSeconds });
  const latest = now.add({ seconds: settings.ping.maxFutureSkewSeconds });
  if (Temporal.Instant.compare(ping.recordedAt, oldest) < 0) return err({ code: 'ping.stale' });
  if (Temporal.Instant.compare(ping.recordedAt, latest) > 0) return err({ code: 'ping.future' });
  return ok(ping);
}
