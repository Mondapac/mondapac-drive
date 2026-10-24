import type { AuthenticatedActor, MarketContext, Result } from '@mondapac-drive/shared-kernel';

/**
 * Where a session token came from (identity design 6.2): a session is bound to one. `cookie` is
 * an admin's panel session, `bearer` a courier's app session, `api-key` a merchant's API key.
 */
export type SessionTransport = 'cookie' | 'bearer' | 'api-key';

/**
 * A presented session credential (platform-foundations design 6.3, as changed by identity
 * design 5.1): the token and the transport it arrived on. The token is a secret: it is never
 * logged, stored, returned or put in an error.
 */
export interface SessionCredential {
  readonly token: string;
  readonly transport: SessionTransport;
}

/**
 * One answer for every cause (foundations 6.3 row 3): unknown, expired, revoked, another
 * Market, another transport, a disabled account. The guard answers `session.invalid`.
 */
export type CredentialRejected = { readonly code: 'credential.rejected' };

/**
 * The port `identity` implements from slice 2 (foundations 6.3; identity design 5.1, 6.2).
 * The actor guard calls it once per request that presents a session credential for the route's
 * population, after the Market guard and the rate limiter.
 *
 * It reads committed state on every call, in a read-only unit of its own, and caches nothing
 * (ADR-0018 decisions 2 and 3). An infrastructure failure throws and yields no actor; the
 * guard then answers `access.unavailable` (fail closed). The return type excludes the system
 * actor.
 *
 * It takes a credential, never `undefined`: a request without one is the Market's anonymous
 * actor, which only the platform's entry adapters may build (foundations 3.7), so the guard
 * attaches it itself. That is the one change to the signature of foundations 6.3, whose
 * `undefined` case it implements.
 */
export interface Authenticator {
  authenticate(
    market: MarketContext,
    credential: SessionCredential,
  ): Promise<Result<AuthenticatedActor, CredentialRejected>>;
}

/**
 * Nest token of the {@link Authenticator}. `IdentityModule` provides and exports it; the actor
 * guard, declared by `app.module.ts`, injects it. Required at start in both roles: an unbound
 * token fails boot (foundations 6.3 row 1), and `platform/` ships no fallback.
 */
export const AUTHENTICATOR = Symbol('AUTHENTICATOR');
