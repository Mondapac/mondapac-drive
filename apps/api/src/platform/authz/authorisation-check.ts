import type { CallContext } from '@mondapac-drive/shared-kernel';
import type { AccessDenied } from './access-denied';
import type { AccessDeclaration } from './access-rule';

/** The answer of {@link AuthorisationCheck}: allowed, or one refusal with its code. */
export type AccessDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly denial: Exclude<AccessDenied, { readonly code: 'access.unauthenticated' }>;
    };

/**
 * The port `identity` implements from slice 2 (platform-foundations design 6.3; identity design
 * 5.2). The gate calls it only for an authenticated actor under a `permissions` or
 * `own-resources` rule. It reads committed state on every call, in a read-only unit of its own
 * and never inside the caller's, and caches nothing: the account is active; the population
 * matches the scope of the rule's keys; for the merchant population the membership is active
 * and the merchant is not suspended; every key is held through the actor's role and known to
 * the registry. It takes the whole declaration, as in the marketplace.
 */
export interface AuthorisationCheck {
  check(context: CallContext, declaration: AccessDeclaration): Promise<AccessDecision>;
}

/**
 * Nest token of the {@link AuthorisationCheck}. `IdentityModule` provides and exports it from
 * slice 2, and from then on it is required at start in both roles (foundations 6.3 row 1).
 */
export const AUTHORISATION_CHECK = Symbol('AUTHORISATION_CHECK');
