// What a module may use from `platform/authz` (identity design 5.2; security review of slice
// 1c, M1). A module imports from this file only (dependency-cruiser
// `modules-reach-authz-through-its-barrel`): the base class, the declaration types, the
// permission helpers, the answers and the gate's token and type, and (identity slice 2) the two
// ports `identity` implements, `Authenticator` and `AuthorisationCheck`, with their tokens; and
// (identity slice 8a-1) the permission registry, its registration helper and the frozen key
// set. The gate's factory and the declaration checks stay inside `platform/`.
export { ACCESS_DENIED_STATUS, type AccessDenied } from './access-denied';
export {
  AUTHENTICATOR,
  type AuthenticateOptions,
  type Authenticator,
  type CredentialRejected,
  type SessionCredential,
  type SessionTransport,
} from './authenticator';
export {
  AUTHORISATION_CHECK,
  type AccessDecision,
  type AuthorisationCheck,
} from './authorisation-check';
export type { AccessDeclaration, AccessRule, PermissionKey } from './access-rule';
export {
  declarePermissions,
  definePermission,
  MAX_PERMISSION_KEY_LENGTH,
  type PermissionCatalogue,
  type PermissionDeclaration,
  type PermissionScope,
} from './permission';
export { frozenKeySet } from './frozen-key-set';
export {
  PermissionRegistry,
  registerPermissions,
  type SealedPermissionCatalogue,
} from './permission-registry';
export { UseCase, UseCaseDefinitionError } from './use-case';
export type { UseCaseGate } from './use-case-gate';
export { USE_CASE_GATE } from './use-case-gate.token';
