import type { HttpException } from '@nestjs/common';
import type { CallContext } from '@mondapac-drive/shared-kernel';
import type { Request, Response } from 'express';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';
import { csrfTokenFor } from '../../../platform/call-context/csrf';
import { clearedSessionCookie, sessionCookie } from '../../../platform/call-context/session-cookie';
import { clientAddressFrom } from '../../../platform/http/client-address';
import { clientAddressOf, clientOriginOf } from '../../../platform/rate-limit/client-origin';
import type { ChangePassword } from '../application/use-cases/change-password.use-case';
import type {
  RequestPasswordReset,
  RequestPasswordResetInput,
} from '../application/use-cases/request-password-reset.use-case';
import type { ResetPassword } from '../application/use-cases/reset-password.use-case';
import { fail, parseStringFields } from './http-body';
import type {
  PasswordChanged,
  CourierPasswordChanged,
  PasswordChangedInSession,
  PasswordResetAccepted,
} from './password.dto';

/** The populations with a reset and a change: admins and couriers (never a merchant). */
type SignInPopulation = RequestPasswordResetInput['population'];

/**
 * The HTTP status of each outcome of the reset and change routes (identity design 5.2; slice 4).
 * The design names the codes; the statuses follow sign-in's (6.3, as built). A wrong current
 * password is 400, a field error on the form, not 401: the session itself is fine. Slice 7b: an
 * admin's wrong code is 400 too, and the HF2 lock is 429 with its wait.
 */
export const PASSWORD_STATUS = {
  'validation.failed': 400,
  'password.rejected': 400,
  'password.current-incorrect': 400,
  'second-factor.invalid': 400,
  'link.rejected': 400,
  'session.invalid': 401,
  'request.throttled': 429,
  'second-factor.locked': 429,
  'request.busy': 503,
  'access.unavailable': 503,
} as const;

/** The JSON-only check of every route here (identity design 6.4). */
const notJson = (request: Request): HttpException | null =>
  request.is('application/json') !== 'application/json'
    ? fail(415, 'request.body-unsupported')
    : null;

/** `POST <population>/password-reset-email`: one answer for every address (AC 21). */
export async function answerPasswordResetEmail(
  context: CallContext,
  request: Request,
  body: unknown,
  population: SignInPopulation,
  useCase: RequestPasswordReset,
): Promise<PasswordResetAccepted | HttpException> {
  const refused = notJson(request);
  if (refused !== null) return refused;
  const input = parseStringFields(body, ['email'] as const);
  if (Array.isArray(input)) return fail(400, 'validation.failed', { fields: input });
  // The origin of the mail counter, from the resolved client address (ADR-0037; never a
  // forwarded header, Hassan I4).
  const origin = clientOriginOf(clientAddressFrom(request));
  if (origin === null) return fail(503, 'access.unavailable');

  const result = await useCase.execute(context, {
    population,
    email: (input as Readonly<Record<'email', string>>).email,
    origin,
  });
  if (result.ok) return result.value;
  const error = result.error;
  switch (error.code) {
    case 'validation.failed':
      return fail(PASSWORD_STATUS[error.code], error.code, { fields: error.fields });
    default:
      return fail(ACCESS_DENIED_STATUS[error.code], error.code);
  }
}

/** `POST <population>/reset-password`: the link's token and the new password. */
export async function answerResetPassword(
  context: CallContext,
  request: Request,
  response: Response,
  body: unknown,
  population: SignInPopulation,
  useCase: ResetPassword,
): Promise<PasswordChanged | HttpException> {
  const refused = notJson(request);
  if (refused !== null) return refused;
  const input = parseStringFields(body, ['token', 'password'] as const);
  if (Array.isArray(input)) return fail(400, 'validation.failed', { fields: input });
  const origin = clientOriginOf(clientAddressFrom(request));
  const address = clientAddressOf(clientAddressFrom(request));
  if (origin === null || address === null) return fail(503, 'access.unavailable');

  const fields = input as Readonly<Record<'token' | 'password', string>>;
  const result = await useCase.execute(context, {
    population,
    token: fields.token,
    password: fields.password,
    client: { origin, address },
  });
  if (result.ok) {
    response.setHeader('Cache-Control', 'no-store');
    return result.value;
  }
  const error = result.error;
  switch (error.code) {
    case 'validation.failed':
      return fail(PASSWORD_STATUS[error.code], error.code, { fields: error.fields });
    case 'password.rejected':
      return fail(PASSWORD_STATUS[error.code], error.code, { rule: error.rule });
    case 'request.throttled':
    case 'request.busy':
      response.setHeader('Retry-After', String(error.retryAfterSeconds));
      return fail(PASSWORD_STATUS[error.code], error.code, {
        retryAfterSeconds: error.retryAfterSeconds,
      });
    case 'link.rejected':
    case 'access.unavailable':
      return fail(PASSWORD_STATUS[error.code], error.code);
    default:
      return fail(ACCESS_DENIED_STATUS[error.code], error.code);
  }
}

/**
 * `POST <population>/change-password`, behind the population's session. On success the session
 * was rotated (identity design 6.2): an admin's new token replaces the cookie and the answer
 * carries its new CSRF token, and a session that ended meanwhile clears the cookie; a courier's
 * new token is in the answer's body, for the app to keep in place of the old one.
 */
export function answerChangePassword(
  context: CallContext,
  request: Request,
  response: Response,
  body: unknown,
  population: 'admin',
  useCase: ChangePassword,
): Promise<PasswordChangedInSession | HttpException>;
export function answerChangePassword(
  context: CallContext,
  request: Request,
  response: Response,
  body: unknown,
  population: 'courier',
  useCase: ChangePassword,
): Promise<CourierPasswordChanged | HttpException>;
export async function answerChangePassword(
  context: CallContext,
  request: Request,
  response: Response,
  body: unknown,
  population: SignInPopulation,
  useCase: ChangePassword,
): Promise<PasswordChangedInSession | CourierPasswordChanged | HttpException> {
  const refused = notJson(request);
  if (refused !== null) return refused;
  // An admin always sends a code (Hassan I2 (b)); a courier has no second factor.
  const sendsCode = population === 'admin';
  const names = sendsCode
    ? (['currentPassword', 'newPassword', 'code'] as const)
    : (['currentPassword', 'newPassword'] as const);
  const input = parseStringFields<'currentPassword' | 'newPassword' | 'code'>(body, names);
  if (Array.isArray(input)) return fail(400, 'validation.failed', { fields: input });
  const origin = clientOriginOf(clientAddressFrom(request));
  const address = clientAddressOf(clientAddressFrom(request));
  if (origin === null || address === null) return fail(503, 'access.unavailable');

  const fields = input as Readonly<Record<'currentPassword' | 'newPassword', string>> & {
    readonly code?: string;
  };
  const result = await useCase.execute(context, {
    currentPassword: fields.currentPassword,
    newPassword: fields.newPassword,
    ...(fields.code === undefined ? {} : { code: fields.code }),
    client: { origin, address },
  });
  if (result.ok) {
    const { token, cookieMaxAgeSeconds } = result.value;
    response.setHeader('Cache-Control', 'no-store');
    if (population === 'courier') return { code: 'password-changed', token };
    response.setHeader(
      'Set-Cookie',
      sessionCookie(population, context.market.marketId, token, cookieMaxAgeSeconds),
    );
    return { code: 'password-changed', csrfToken: csrfTokenFor(token) };
  }
  const error = result.error;
  switch (error.code) {
    case 'validation.failed':
      return fail(PASSWORD_STATUS[error.code], error.code, { fields: error.fields });
    case 'password.rejected':
      return fail(PASSWORD_STATUS[error.code], error.code, { rule: error.rule });
    case 'request.throttled':
    case 'request.busy':
    case 'second-factor.locked':
      response.setHeader('Retry-After', String(error.retryAfterSeconds));
      return fail(PASSWORD_STATUS[error.code], error.code, {
        retryAfterSeconds: error.retryAfterSeconds,
      });
    case 'session.invalid':
      if (population === 'admin') {
        response.setHeader('Set-Cookie', clearedSessionCookie(population, context.market.marketId));
      }
      return fail(PASSWORD_STATUS[error.code], error.code);
    case 'password.current-incorrect':
    case 'second-factor.invalid':
    case 'access.unavailable':
      return fail(PASSWORD_STATUS[error.code], error.code);
    default:
      return fail(ACCESS_DENIED_STATUS[error.code], error.code);
  }
}
