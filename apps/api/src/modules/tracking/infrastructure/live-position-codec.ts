import { Temporal } from '@mondapac-drive/shared-kernel';
import type { LivePosition } from '../domain/live-position';

/** A live position as stored: the instant as epoch milliseconds. */
interface StoredPosition {
  readonly c: string;
  readonly lat: number;
  readonly lng: number;
  readonly acc: number;
  readonly hdg?: number;
  readonly spd?: number;
  readonly at: number;
  readonly area?: string;
}

export function encodePosition(position: LivePosition): string {
  const stored: StoredPosition = {
    c: position.courierId,
    lat: position.point.lat,
    lng: position.point.lng,
    acc: position.accuracyMetres,
    ...(position.headingDegrees === undefined ? {} : { hdg: position.headingDegrees }),
    ...(position.speedKmh === undefined ? {} : { spd: position.speedKmh }),
    at: position.recordedAt.epochMilliseconds,
    ...(position.serviceAreaCode === undefined ? {} : { area: position.serviceAreaCode }),
  };
  return JSON.stringify(stored);
}

export function decodePosition(text: string): LivePosition {
  const stored = JSON.parse(text) as StoredPosition;
  return {
    courierId: stored.c,
    point: { lat: stored.lat, lng: stored.lng },
    accuracyMetres: stored.acc,
    ...(stored.hdg === undefined ? {} : { headingDegrees: stored.hdg }),
    ...(stored.spd === undefined ? {} : { speedKmh: stored.spd }),
    recordedAt: Temporal.Instant.fromEpochMilliseconds(stored.at),
    ...(stored.area === undefined ? {} : { serviceAreaCode: stored.area }),
  };
}
