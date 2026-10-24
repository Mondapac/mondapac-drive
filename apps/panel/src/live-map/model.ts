// The live map's data (Drive): what the page server hands the browser, and the pure rules that
// turn the delivery list into pins and exceptions. Only ids, statuses and rounded points cross
// to the browser; never an address, a name of a recipient or a phone number.

import type { DeliveryException, DeliveryStatus, DeliverySummary, GeoPoint } from '../ops/types.ts';

/** The statuses the map pins: a delivery on its way, waiting for a courier, or failed. */
export const MAP_STATUSES = [
  'DISPATCHING',
  'ASSIGNED',
  'AT_PICKUP',
  'PICKED_UP',
  'AT_DROPOFF',
  'DELIVERY_FAILED',
  'RETURNING',
] as const satisfies readonly DeliveryStatus[];

export interface MapDelivery {
  readonly id: string;
  readonly reference: string;
  readonly status: DeliveryStatus;
  readonly temperature: DeliverySummary['temperature'];
  readonly courierId: string | null;
  /** Null when the page server could not read the points; the delivery is listed, not pinned. */
  readonly pickup: GeoPoint | null;
  readonly dropoff: GeoPoint | null;
  readonly exception: MapExceptionKind | null;
}

/** Why a delivery is on the exceptions list. */
export type MapExceptionKind = DeliveryException | 'failed';

/** A courier near the map's center, as the tracking API sends it. */
export interface NearbyCourier {
  readonly courierId: string;
  readonly lat: number;
  readonly lng: number;
  readonly accuracyM: number;
  readonly headingDeg?: number;
  readonly speedKmh?: number;
  readonly recordedAt: string;
  readonly distanceM: number;
}

export interface TrailPoint {
  readonly lat: number;
  readonly lng: number;
  readonly recordedAt: string;
}

/** Four decimals, about 11 m: the precision the relay lets cross and the API answers in. */
export const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

export const roundPoint = (point: GeoPoint): GeoPoint => ({
  lat: round4(point.lat),
  lng: round4(point.lng),
});

/** The exception of a delivery: the API's own flag first, then a failed delivery. */
export function exceptionOf(
  status: DeliveryStatus,
  flagged: DeliveryException | null | undefined,
): MapExceptionKind | null {
  if (flagged === 'dispatch-exhausted' || flagged === 'cold-chain-breach') return flagged;
  return status === 'DELIVERY_FAILED' ? 'failed' : null;
}

/**
 * The point a delivery's pin stands on: the pickup until the parcel is collected and on a
 * return, the drop-off while the courier carries it and where it failed.
 */
export function pinPoint(delivery: MapDelivery): GeoPoint | null {
  switch (delivery.status) {
    case 'PICKED_UP':
    case 'AT_DROPOFF':
    case 'DELIVERY_FAILED':
      return delivery.dropoff;
    default:
      return delivery.pickup;
  }
}

const EXCEPTION_ORDER: Readonly<Record<MapExceptionKind, number>> = {
  'cold-chain-breach': 0,
  'dispatch-exhausted': 1,
  failed: 2,
};

/** The deliveries with an exception, the most urgent kind first, then by reference. */
export function exceptionsOf(deliveries: readonly MapDelivery[]): readonly MapDelivery[] {
  return deliveries
    .filter((delivery) => delivery.exception !== null)
    .sort(
      (a, b) =>
        EXCEPTION_ORDER[a.exception as MapExceptionKind] -
          EXCEPTION_ORDER[b.exception as MapExceptionKind] ||
        a.reference.localeCompare(b.reference),
    );
}

const EARTH_RADIUS_M = 6_371_008.8;
const radians = (degrees: number) => (degrees * Math.PI) / 180;

/** Great-circle distance in metres. */
export function distanceMetres(a: GeoPoint, b: GeoPoint): number {
  const dLat = radians(b.lat - a.lat);
  const dLng = radians(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The circle the stream asks for: the view's center and its half-diagonal, whole metres. */
export function viewCircle(
  center: GeoPoint,
  corner: GeoPoint,
  maxRadiusM: number,
): { readonly center: GeoPoint; readonly radiusM: number } {
  const radius = Math.ceil(distanceMetres(center, corner));
  return { center: roundPoint(center), radiusM: Math.max(100, Math.min(maxRadiusM, radius)) };
}
