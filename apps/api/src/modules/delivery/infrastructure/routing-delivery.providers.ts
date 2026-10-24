import type { GeoPoint, MarketContext } from '@mondapac-drive/shared-kernel';
import {
  GeocodingUnavailableError,
  InvalidAddressQueryError,
  type RoutingProvider,
} from '../../../platform/routing';
import type { DistanceProvider, GeocodeMiss, Geocoder } from '../application/ports';
import type { VehicleType } from '../domain/vehicle';

/** Delivery's distance port over the platform router: road distance, straight line as fallback. */
export class RoutingDistanceProvider implements DistanceProvider {
  constructor(private readonly routing: RoutingProvider) {}

  async roadDistanceMetres(
    market: MarketContext,
    from: GeoPoint,
    to: GeoPoint,
    vehicle: VehicleType,
  ): Promise<number> {
    return (await this.routing.route(market, from, to, vehicle)).distanceMetres;
  }
}

/** Delivery's geocoding port over the platform router (address, else the postcode's centre). */
export class RoutingGeocoder implements Geocoder {
  constructor(private readonly routing: RoutingProvider) {}

  async locate(
    market: MarketContext,
    address: string,
    postcode: string,
  ): Promise<GeoPoint | GeocodeMiss> {
    try {
      const found = await this.routing.geocode(market, { address, postcode });
      return found === undefined ? 'not-found' : found.point;
    } catch (error) {
      if (error instanceof GeocodingUnavailableError) return 'unavailable';
      if (error instanceof InvalidAddressQueryError) return 'not-found';
      throw error;
    }
  }
}
