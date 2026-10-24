import type { HttpException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';
import { clientAddressFrom } from '../../../platform/http/client-address';
import { clientAddressOf, clientOriginOf } from '../../../platform/rate-limit/client-origin';
import type { SignInClient } from '../application/use-cases/sign-in-courier.use-case';
import { deviceOf } from '../domain/device';
import { fail, parseStringFields } from './http-body';

/**
 * The HTTP status of each outcome of the admin routes (identity design 5.2, 6.3; slice 7b). The
 * codes are the design's; the statuses follow sign-in's: a refused token or code is a field
 * error (400), the HF2 lock and the counters 429 with their wait, a full hash queue and a
 * Market without the 7b policy values 503.
 */
export const ADMIN_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'password.rejected': 400,
  'password.current-incorrect': 400,
  'link.rejected': 400,
  'challenge.rejected': 400,
  'invitation.rejected': 400,
  'invitation.enrolment-expired': 400,
  'second-factor.invalid': 400,
  'credentials.invalid': 401,
  'session.invalid': 401,
  'email-verification-required': 403,
  'account.disabled': 403,
  'second-factor.unavailable': 409,
  'step-up.action-unknown': 404,
  'step-up.locked': 409,
  'second-factor.required': 403,
  'second-factor.enrolment-required': 403,
  'request.throttled': 429,
  'second-factor.locked': 429,
  'request.busy': 503,
  'access.unavailable': 503,
});

/** A refusal of a use case, as the routes map it. */
export type AdminRefusal = {
  readonly code: string;
  readonly fields?: readonly unknown[];
  readonly rule?: string;
  readonly retryAfterSeconds?: number;
  readonly details?: object;
};

/** The error answer of a refusal (5.2): its status, its details, and `Retry-After` with a wait. */
export function adminFailure(response: Response, error: AdminRefusal): HttpException {
  const status =
    ADMIN_STATUS[error.code] ??
    ACCESS_DENIED_STATUS[error.code as keyof typeof ACCESS_DENIED_STATUS] ??
    500;
  if (error.fields !== undefined) return fail(status, error.code, { fields: error.fields });
  if (error.rule !== undefined) return fail(status, error.code, { rule: error.rule });
  if (error.retryAfterSeconds !== undefined) {
    response.setHeader('Retry-After', String(error.retryAfterSeconds));
    return fail(status, error.code, { retryAfterSeconds: error.retryAfterSeconds });
  }
  if (error.details !== undefined) return fail(status, error.code, error.details);
  return fail(status, error.code);
}

/** The JSON-only check and the closed string body of every admin route (6.4, 5.2). */
export function adminBody<const F extends string>(
  request: Request,
  body: unknown,
  fields: readonly F[],
): Readonly<Record<F, string>> | HttpException {
  if (request.is('application/json') !== 'application/json') {
    return fail(415, 'request.body-unsupported');
  }
  const input = parseStringFields(body, fields);
  if (Array.isArray(input)) return fail(400, 'validation.failed', { fields: input });
  return input as Readonly<Record<F, string>>;
}

/**
 * The client's origin and address from the resolved client address (ADR-0037 decision 8), never
 * a forwarded header (Hassan I4), and the coarse device of its User-Agent for a session it
 * opens (profile package 4).
 */
export function adminClient(request: Request): SignInClient | HttpException {
  const resolved = clientAddressFrom(request);
  const origin = clientOriginOf(resolved);
  const address = clientAddressOf(resolved);
  if (origin === null || address === null) return fail(503, 'access.unavailable');
  return { origin, address, device: deviceOf(request.get('user-agent')) };
}
