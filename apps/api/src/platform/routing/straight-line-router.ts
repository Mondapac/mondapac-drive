import type { GeoPoint } from '@mondapac-drive/shared-kernel';
import type { RoutingConfig, RoutingVehicleType } from './routing-config';
import type { RouteEstimate } from './routing-provider';

const EARTH_RADIUS_METRES = 6_371_000;

/** Great-circle distance in metres (haversine). */
export function greatCircleMetres(from: GeoPoint, to: GeoPoint): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(to.lat - from.lat);
  const dLng = rad(to.lng - from.lng);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(from.lat)) * Math.cos(rad(to.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.sqrt(a));
}

/**
 * The fallback estimate: great-circle distance times the Market's road factor, travelled at the
 * vehicle's typical speed. Always answers, never calls out.
 */
export class StraightLineRouter {
  constructor(private readonly config: RoutingConfig['straightLine']) {}

  route(origin: GeoPoint, destination: GeoPoint, vehicle: RoutingVehicleType): RouteEstimate {
    const distanceMetres = Math.round(
      greatCircleMetres(origin, destination) * this.config.roadFactor,
    );
    const metresPerSecond = (this.config.speedsKmh[vehicle] * 1000) / 3600;
    return {
      distanceMetres,
      durationSeconds: Math.round(distanceMetres / metresPerSecond),
      source: 'straight_line',
    };
  }

  matrix(
    origins: readonly GeoPoint[],
    destinations: readonly GeoPoint[],
    vehicle: RoutingVehicleType,
  ): RouteEstimate[][] {
    return origins.map((origin) =>
      destinations.map((destination) => this.route(origin, destination, vehicle)),
    );
  }
}
