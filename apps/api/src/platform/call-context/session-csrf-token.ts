import { createParamDecorator } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';

// The CSRF token of the request's session (identity design 6.4), recorded by ActorGuard when it
// authenticated a cookie session, so that the actor-summary route can hand it to the page. The
// guard is the only writer (it imports `recordSessionCsrfToken`); routes read it with
// `@SessionCsrfToken()`.

const tokens = new WeakMap<object, string>();

/** Records the CSRF token of the request's authenticated cookie session. ActorGuard only. */
export function recordSessionCsrfToken(request: object, token: string): void {
  if (tokens.has(request)) throw new Error('recordSessionCsrfToken: already recorded');
  tokens.set(request, token);
}

/** The request's CSRF token, or null when the request carries no authenticated cookie session. */
export function sessionCsrfTokenOf(request: object): string | null {
  return tokens.get(request) ?? null;
}

/** Parameter decorator: the CSRF token of the request's cookie session, or null. */
export const SessionCsrfToken = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | null =>
    sessionCsrfTokenOf(context.switchToHttp().getRequest<object>()),
);
