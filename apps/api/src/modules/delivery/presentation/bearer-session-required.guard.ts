import type { IncomingMessage } from 'node:http';
import { HttpException, Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';

/**
 * Refuses a request without a session before a route's interceptors run, so an upload is never
 * buffered for a caller who has not signed in. It runs after the global guards: the actor guard
 * has already refused a malformed or rejected bearer token on a courier route that reads a
 * session, so a request that still carries an `Authorization` header here is a signed-in
 * courier. One without it answers 401 `access.unauthenticated`, as the use case would.
 */
@Injectable()
export class BearerSessionRequiredGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<IncomingMessage>();
    if (request.headers.authorization !== undefined) return true;
    throw new HttpException({ statusCode: 401, code: 'access.unauthenticated' }, 401);
  }
}
