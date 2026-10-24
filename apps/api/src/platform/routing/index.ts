// The public interface of platform/routing (handoff 12): the port, its token and its types.
// Modules bind their own distance or ETA ports to ROUTING_PROVIDER in their infrastructure/.
export {
  GeocodingUnavailableError,
  InvalidAddressQueryError,
  InvalidMatrixRequestError,
  MAX_ADDRESS_LENGTH,
  MAX_MATRIX_CELLS,
  ROUTING_PROVIDER,
} from './routing-provider';
export type {
  AddressQuery,
  GeocodedAddress,
  RouteEstimate,
  RouteSource,
  RoutingProvider,
} from './routing-provider';
export { ROUTING_VEHICLE_TYPES } from './routing-config';
export type { RoutingVehicleType } from './routing-config';
export { RoutingModule } from './routing.module';
