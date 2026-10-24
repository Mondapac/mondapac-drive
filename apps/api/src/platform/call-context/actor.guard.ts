import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { isMinted } from '@mondapac-drive/shared-kernel';
import type { MarketContext, Population } from '@mondapac-drive/shared-kernel';
import { anonymousActor } from '@mondapac-drive/shared-kernel/contexts';
import {
  AUTHENTICATOR,
  type Authenticator,
  type SessionTransport,
} from '../authz/authenticator';
import { MarketRegistry } from '../market-config/market-registry';
import { isMarketContextExempt } from '../market-context/market-context.guard';
import { marketContextOf } from '../market-context/market.decorator';
import { CSRF_HEADER, csrfTokenFor, csrfTokenMatches, isUnsafeMethod, originRefused } from './csrf';
import { attachActor } from './request-actor';
import { clearedSessionCookie, readCookie, sessionCookieName } from './session-cookie';
import { recordSessionCsrfToken } from './session-csrf-token';
import { READS_SESSION, routePopulationOf } from './route-population.decorator';

/** The answer codes of this guard (identity design 5.2). */
export const SESSION_INVALID = 'session.invalid';
export const REQUEST_CSRF = 'request.csrf';
const UNAVAILABLE = 'access.unavailable';

type Refusal = 'session.invalid' | 'request.csrf' | 'access.unavailable';
const STATUS: Readonly<Record<Refusal, number>> = {
  'session.invalid': 401,
  'request.csrf': 403,
  'access.unavailable': 503,
};

/**
 * The one transport each population's credential travels on (a security floor in code, never
 * in Market config): admins sign in to the panel with a cookie; couriers sign in from the app
 * and send `Authorization: Bearer <session token>`; merchants send `Authorization: Bearer
 * <API key>`. A session is bound to its transport, so a token of one never works on another.
 */
export const CREDENTIAL_TRANSPORT: Readonly<Record<Population, SessionTransport>> = Object.freeze({
  admin: 'cookie',
  merchant: 'api-key',
  courier: 'bearer',
});

/** `Bearer <token>`, the token in the session alphabet (base64url). Nothing else is accepted. */
const BEARER = /^Bearer ([A-Za-z0-9_-]{20,256})$/;

/** What the request carries in its `Authorization` header. */
type BearerRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'one'; readonly value: string }
  | { readonly kind: 'refused' };

function readBearer(header: string | string[] | undefined): BearerRead {
  if (header === undefined) return { kind: 'absent' };
  if (Array.isArray(header) || header.length > 300) return { kind: 'refused' };
  const match = BEARER.exec(header);
  return match === null ? { kind: 'refused' } : { kind: 'one', value: match[1]! };
}

/**
 * Attaches the actor of every market-scoped request (copied from the marketplace's actor guard,
 * its identity design 6.2 to 6.4, with Drive's transports): the third global guard, after the
 * Market guard and the rate limiter, so a refused or throttled request never gets this far. In
 * order:
 *
 * 1. **`Authorization` header**: accepted only on a route that reads a session of a bearer
 *    population (courier, merchant). Anywhere else, a request that carries one is
 *    `session.invalid` (401), so a token is never silently ignored.
 * 2. **Origin checks**: the route's population is its controller's `@RoutePopulation`, never the
 *    session's. A request with an unsafe method is `request.csrf` (403) when its route has no
 *    population, when `Sec-Fetch-Site` is present and not `same-origin`, or when `Origin` is
 *    present and not on the Market's `allowedOrigins` of that population. Admin routes also
 *    refuse a request without either header (`ORIGIN_HEADERS_REQUIRED`).
 * 3. **Credential**: a route reads one only when it is marked `@ReadsSession()`; otherwise its
 *    actor is the Market's anonymous actor (sign-in and invitation routes). An admin route reads
 *    only the cookie named for its population and the request's Market, and a cookie sent to a
 *    bearer route is never read. A malformed or repeated credential is `session.invalid`. No
 *    credential: the anonymous actor, and the use case's rule decides.
 * 4. **CSRF token** (cookie only): with an unsafe method the request must carry `x-csrf-token`,
 *    equal to the HMAC of the session token, compared in constant time; otherwise
 *    `request.csrf`. A bearer credential is not ambient, so it needs none.
 * 5. **Authenticator** (identity's): a rejected credential is `session.invalid` (the cookie is
 *    cleared); an exception is `access.unavailable` (503, fail closed). The actor must be of the
 *    route's population and of the request's Market.
 *
 * Forwarded headers are never read. The token is never logged; a refusal is logged with its
 * reason and the correlation id.
 */
@Injectable()
export class ActorGuard implements CanActivate {
  readonly #logger = new Logger('ActorGuard');

  constructor(
    private readonly reflector: Reflector,
    private readonly markets: MarketRegistry,
    @Inject(AUTHENTICATOR) private readonly authenticator: Authenticator,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      throw new Error('ActorGuard attaches the actor of HTTP requests only');
    }
    if (isMarketContextExempt(context.getClass())) return true;
    const http = context.switchToHttp();
    const request = http.getRequest<IncomingMessage & { id?: unknown }>();
    const response = http.getResponse<ServerResponse>();
    const market = marketContextOf(request);
    // The class's own population only (never a method's): the start-up check refuses a
    // `@RoutePopulation` on a method, and this read ignores one all the same.
    const population = routePopulationOf(context.getClass());
    const readsSession =
      population !== undefined &&
      this.reflector.getAllAndOverride<boolean | undefined>(READS_SESSION, [
        context.getHandler(),
        context.getClass(),
      ]) === true;
    const transport = population === undefined ? null : CREDENTIAL_TRANSPORT[population];
    const refuse = (code: Refusal, reason: string): never =>
      this.refuse(request, response, market, population, transport, readsSession, code, reason);

    const bearerRoute = readsSession && transport !== null && transport !== 'cookie';
    if (request.headers.authorization !== undefined && !bearerRoute) {
      refuse(SESSION_INVALID, 'authorization-header');
    }
    const unsafe = isUnsafeMethod(request.method);
    if (unsafe) {
      // Fail closed: an unsafe route with no population has no allow-list to check against.
      if (population === undefined) return refuse(REQUEST_CSRF, 'no-route-population');
      const origins = this.markets.get(market.marketId).allowedOrigins;
      if (originRefused(request.headers, population, origins[population])) {
        refuse(REQUEST_CSRF, 'origin');
      }
    }
    if (!readsSession || population === undefined || transport === null) {
      attachActor(request, anonymousActor(market));
      return true;
    }

    let token: string;
    if (transport === 'cookie') {
      const cookie = readCookie(
        request.headers.cookie,
        sessionCookieName(population, market.marketId),
      );
      if (cookie.kind === 'refused') refuse(SESSION_INVALID, 'cookie-refused');
      if (cookie.kind !== 'one') {
        attachActor(request, anonymousActor(market));
        return true;
      }
      if (unsafe && !csrfTokenMatches(cookie.value, request.headers[CSRF_HEADER])) {
        refuse(REQUEST_CSRF, 'csrf-token');
      }
      token = cookie.value;
    } else {
      const bearer = readBearer(request.headers.authorization);
      if (bearer.kind === 'refused') refuse(SESSION_INVALID, 'bearer-refused');
      if (bearer.kind !== 'one') {
        attachActor(request, anonymousActor(market));
        return true;
      }
      token = bearer.value;
    }

    let authenticated;
    try {
      authenticated = await this.authenticator.authenticate(market, { token, transport });
    } catch {
      return refuse(UNAVAILABLE, 'authenticator-error');
    }
    if (!authenticated.ok) return refuse(SESSION_INVALID, 'credential-rejected');
    const actor = authenticated.value;
    if (
      !isMinted(actor) ||
      actor.kind !== 'authenticated' ||
      actor.population !== population ||
      actor.marketId !== market.marketId
    ) {
      return refuse(SESSION_INVALID, 'actor-mismatch');
    }
    attachActor(request, actor);
    if (transport === 'cookie') recordSessionCsrfToken(request, csrfTokenFor(token));
    return true;
  }

  private refuse(
    request: { id?: unknown },
    response: ServerResponse,
    market: MarketContext,
    population: Population | undefined,
    transport: SessionTransport | null,
    readsSession: boolean,
    code: Refusal,
    reason: string,
  ): never {
    this.#logger.warn({
      msg: 'actor.refused',
      code,
      reason,
      population: population ?? null,
      marketId: market.marketId,
      correlationId: request.id ?? null,
    });
    // Only a cookie route that reads a session clears its cookie: an `Authorization` header
    // sent to sign-in must not sign the browser out of the population's session.
    if (
      code === SESSION_INVALID &&
      readsSession &&
      transport === 'cookie' &&
      population !== undefined
    ) {
      response.setHeader('Set-Cookie', clearedSessionCookie(population, market.marketId));
    }
    throw new HttpException({ statusCode: STATUS[code], code }, STATUS[code]);
  }
}
