import type { GeoPoint, MarketContext } from '@mondapac-drive/shared-kernel';
import type { RoutingVehicleType } from './routing-config';

/** Where an estimate came from: the road network, or the straight-line fallback. */
export type RouteSource = 'road' | 'straight_line';

/** One leg from an origin to a destination for one vehicle. */
export interface RouteEstimate {
  readonly distanceMetres: number;
  /** Travel time; for a courier on the way this is the ETA. */
  readonly durationSeconds: number;
  readonly source: RouteSource;
}

/** An address to geocode: the free-text address and, when known, its postcode. */
export interface AddressQuery {
  readonly address: string;
  readonly postcode?: string;
}

/** A geocoded address. */
export interface GeocodedAddress {
  readonly point: GeoPoint;
  /** The postcode the provider found, or undefined when the answer has none. */
  readonly postcode: string | undefined;
  /**
   * `address`: the point of the address itself. `postcode`: the address was not found and the
   * point is the centre of its postcode, good for a quote but not for a drop-off pin.
   */
  readonly precision: 'address' | 'postcode';
}

/**
 * Road routing and geocoding for a Market (handoff 12). Route answers never fail: when the
 * provider is down, slow or open-circuited, the answer is the straight-line estimate and says
 * so in `source`. Geocoding has no fallback and throws {@link GeocodingUnavailableError}.
 *
 * Addresses and coordinates are personal data: implementations never log them.
 */
export interface RoutingProvider {
  route(
    market: MarketContext,
    origin: GeoPoint,
    destination: GeoPoint,
    vehicle: RoutingVehicleType,
  ): Promise<RouteEstimate>;
  /** `result[i][j]` is the leg from `origins[i]` to `destinations[j]`. */
  matrix(
    market: MarketContext,
    origins: readonly GeoPoint[],
    destinations: readonly GeoPoint[],
    vehicle: RoutingVehicleType,
  ): Promise<RouteEstimate[][]>;
  /**
   * The point and postcode of an address in the Market. When the address is not found and a
   * postcode is given, the answer is the postcode's centre (`precision: 'postcode'`). Undefined
   * when neither is found.
   */
  geocode(market: MarketContext, query: AddressQuery): Promise<GeocodedAddress | undefined>;
}
export const ROUTING_PROVIDER = Symbol('RoutingProvider');

/** The most cells one matrix call may ask for (the Google Routes limit without traffic). */
export const MAX_MATRIX_CELLS = 625;

/** A matrix larger than {@link MAX_MATRIX_CELLS}. */
export class InvalidMatrixRequestError extends Error {
  constructor(readonly reason: 'too-large') {
    super(`Invalid route matrix request: ${reason}`);
    this.name = 'InvalidMatrixRequestError';
  }
}

/** Geocoding is not configured for the Market, or its provider failed. */
export class GeocodingUnavailableError extends Error {
  constructor(readonly code: 'routing.geocoding-unconfigured' | 'routing.provider-failed') {
    super(code);
    this.name = 'GeocodingUnavailableError';
  }
}

/** The most characters an address query may have. */
export const MAX_ADDRESS_LENGTH = 500;
const POSTCODE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9 -]{1,9}$/;

/** An empty or overlong address, or a postcode that is not a postcode. */
export class InvalidAddressQueryError extends Error {
  constructor(readonly field: 'address' | 'postcode') {
    super(`Invalid address query: ${field}`);
    this.name = 'InvalidAddressQueryError';
  }
}

/** @throws InvalidAddressQueryError; the postcode becomes part of a provider filter. */
export function checkAddressQuery(query: AddressQuery): void {
  const address = query.address.trim();
  if (address.length === 0 || address.length > MAX_ADDRESS_LENGTH) {
    throw new InvalidAddressQueryError('address');
  }
  if (query.postcode !== undefined && !POSTCODE_SHAPE.test(query.postcode)) {
    throw new InvalidAddressQueryError('postcode');
  }
}
