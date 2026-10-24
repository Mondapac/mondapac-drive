// Server-only entry (ADR-0037 decision 9): importing this from a client component fails the build.
import 'server-only';

export {
  CLIENT_ADDRESS_HEADER,
  parseClientAddressKey,
  signClientAddress,
  signForRequest,
  MissingClientAddressError,
  type ClientAddressKey,
} from './client-address.ts';
export { INTERNAL_ADDRESS_HEADER } from './client-address-source.ts';
