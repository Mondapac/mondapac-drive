// Public contracts of the identity module (ADR-0008): event types, the permission catalogue
// (identity design 5.3) and the facade interface.
// Other modules may import only what this file exports, through ../index.ts. Event
// definitions are declared in domain/events/ and re-exported here (ADR-0006 decision 6), as are
// the audited actions of domain/audit/ (docs/design/domain/platform-audit.md 3.2).
export { IDENTITY_EVENTS } from '../domain/events';
export { IDENTITY_AUDIT_ACTIONS } from '../domain/audit';
export * from './permissions';
export { IDENTITY_FACADE, type ActorDescription, type IdentityFacade } from './identity.facade';
