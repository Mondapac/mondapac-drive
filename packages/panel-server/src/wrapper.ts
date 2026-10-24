// Entry for `apps/<app>/server.mjs`. It has no `server-only` import because it runs outside
// Next.js; the signer entry (`index.ts`) is the server-only one.
export {
  INTERNAL_ADDRESS_HEADER,
  applyClientAddress,
  parseClientAddressSource,
  refuseUntrustedAddress,
  type ClientAddressSource,
  type RefusalReason,
} from './client-address-source.ts';
export { createPanelServer, type PanelServerOptions } from './server.ts';
