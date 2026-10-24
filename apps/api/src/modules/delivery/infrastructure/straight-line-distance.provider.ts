import type { GeoPoint } from '@mondapac-drive/shared-kernel';
import type { DistanceProvider } from '../application/ports.js';

const EARTH_RADIUS_METRES = 6_371_000;

/**
 * Great-circle distance times a road factor. A stand-in until the routing adapter (Google
 * Routes or Mapbox) is chosen; quotes made with it are estimates.
 */
export class StraightLineDistanceProvider implements DistanceProvider {
  constructor(private readonly roadFactor = 1.3) {}

  async roadDistanceMetres(from: GeoPoint, to: GeoPoint): Promise<number> {
    const rad = (deg: number) => (deg * Math.PI) / 180;
    const dLat = rad(to.lat - from.lat);
    const dLng = rad(to.lng - from.lng);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(rad(from.lat)) * Math.cos(rad(to.lat)) * Math.sin(dLng / 2) ** 2;
    const metres = 2 * EARTH_RADIUS_METRES * Math.asin(Math.sqrt(a));
    return Math.round(metres * this.roadFactor);
  }
}
