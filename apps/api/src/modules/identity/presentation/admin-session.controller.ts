import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Logger,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiForbiddenResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { CallContext } from '@mondapac-drive/shared-kernel';
import type { Request, Response } from 'express';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER, csrfTokenFor } from '../../../platform/call-context/csrf';
import { clearedSessionCookie, sessionCookie } from '../../../platform/call-context/session-cookie';
import { SessionCsrfToken } from '../../../platform/call-context/session-csrf-token';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { RateLimit } from '../../../platform/rate-limit/rate-limit.decorator';
import { CompleteAdminSignIn } from '../application/use-cases/complete-admin-sign-in.use-case';
import { DescribeActor } from '../application/use-cases/describe-actor.use-case';
import { SignInAdmin } from '../application/use-cases/sign-in-admin.use-case';
import { SignOut } from '../application/use-cases/sign-out.use-case';
import { adminBody, adminClient, adminFailure } from './admin.answer';
import {
  AdminSecondFactorRequest,
  AdminSessionSummary,
  AdminSignedIn,
  AdminSignInRequest,
  AdminSignInStep,
} from './admin.dto';
import { SignedOut } from './api-error.dto';
import { fail } from './http-body';
import { ApiErrorBody } from './api-error.dto';

/**
 * Admin sign-in, its code step, sign-out and the session summary over HTTP (identity design 3.5,
 * 6.1 to 6.4, 7.2, 8.6 rows 2 and 9; AC 10; slice 7b). Thin adapters: the `CallContext` comes
 * from `@Call()`, each route calls one use case through its gate and maps the answer to the
 * error format of 5.2. JSON only.
 *
 * - `POST sign-in` (anonymous): a correct password never opens a session. It answers
 *   `second-factor-required` with a challenge token, or `second-factor-enrolment-required` (an
 *   enrolment link was mailed), or `second-factor.locked` (429).
 * - `POST second-factor` (anonymous): the challenge token and a code; on success the
 *   `__Host-session-admin-<MARKET>` cookie (`SameSite=Strict`, no `Max-Age`: an admin session
 *   ends with the browser and is never persistent) and the CSRF token.
 * - `POST sign-out` and `GET session` read the admin session cookie of the request's Market.
 *
 * Every route logs its outcome code with the correlation id; never the email, the password, a
 * code, a token or the address.
 */
@ApiTags('identity')
@RoutePopulation('admin')
@Controller('identity/admin')
export class AdminSessionController {
  readonly #logger = new Logger('AdminSessionController');

  constructor(
    private readonly signInAdmin: SignInAdmin,
    private readonly completeAdminSignIn: CompleteAdminSignIn,
    private readonly signOut: SignOut,
    private readonly describeActor: DescribeActor,
  ) {}

  @Post('sign-in')
  @HttpCode(200)
  @RateLimit('anonymous-identity')
  @ApiOperation({
    summary: "An admin's password step",
    description:
      'Email and password. An unknown address, a wrong password and an account of another ' +
      'type or Market all answer credentials.invalid. A correct password never opens a ' +
      'session: with an active second factor the answer asks for a code and carries a ' +
      'challenge token; without one an enrolment link is mailed to the account.',
  })
  @ApiBody({ type: AdminSignInRequest })
  @ApiOkResponse({ type: AdminSignInStep })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: 'credentials.invalid' })
  @ApiForbiddenResponse({
    type: ApiErrorBody,
    description: 'email-verification-required; request.csrf (a refused origin)',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiTooManyRequestsResponse({
    type: ApiErrorBody,
    description:
      'request.throttled or second-factor.locked (details.retryAfterSeconds, Retry-After)',
  })
  @ApiServiceUnavailableResponse({
    type: ApiErrorBody,
    description: 'request.busy or access.unavailable',
  })
  async signIn(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<AdminSignInStep> {
    const input = adminBody(request, body, ['email', 'password'] as const);
    const client = adminClient(request);
    let outcome: AdminSignInStep | HttpException;
    if (input instanceof HttpException) outcome = input;
    else if (client instanceof HttpException) outcome = client;
    else {
      const result = await this.signInAdmin.execute(context, { ...input, client });
      if (!result.ok) outcome = adminFailure(response, result.error);
      else if (result.value.code === 'second-factor.locked') {
        outcome = adminFailure(response, result.value);
      } else {
        response.setHeader('Cache-Control', 'no-store');
        outcome =
          result.value.code === 'second-factor-required'
            ? {
                code: result.value.code,
                challengeToken: result.value.challengeToken,
                expiresAt: result.value.expiresAt.toString(),
              }
            : { code: result.value.code };
      }
    }
    return this.settle('identity.admin-sign-in', context, outcome);
  }

  @Post('second-factor')
  @HttpCode(200)
  @RateLimit('anonymous-identity')
  @ApiOperation({
    summary: "An admin's code step",
    description:
      'The challenge token of the password step and a code from the app, or a recovery code. ' +
      'On success the admin session cookie is set (it ends with the browser).',
  })
  @ApiBody({ type: AdminSecondFactorRequest })
  @ApiOkResponse({
    type: AdminSignedIn,
    headers: { 'Set-Cookie': { description: 'The admin session cookie' } },
  })
  @ApiBadRequestResponse({
    type: ApiErrorBody,
    description: 'validation.failed, challenge.rejected or second-factor.invalid',
  })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'account.disabled; request.csrf' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiTooManyRequestsResponse({
    type: ApiErrorBody,
    description: 'second-factor.locked or request.throttled (details.retryAfterSeconds)',
  })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async secondFactor(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<AdminSignedIn> {
    const input = adminBody(request, body, ['challengeToken', 'code'] as const);
    const client = adminClient(request);
    let outcome: AdminSignedIn | HttpException;
    if (input instanceof HttpException) outcome = input;
    else if (client instanceof HttpException) outcome = client;
    else {
      const result = await this.completeAdminSignIn.execute(context, { ...input, client });
      if (!result.ok) outcome = adminFailure(response, result.error);
      else {
        response.setHeader(
          'Set-Cookie',
          sessionCookie('admin', context.market.marketId, result.value.token, null),
        );
        response.setHeader('Cache-Control', 'no-store');
        outcome = { code: 'signed-in', csrfToken: csrfTokenFor(result.value.token) };
      }
    }
    return this.settle('identity.admin-second-factor', context, outcome);
  }

  @Post('sign-out')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Sign out of the current admin session',
    description: 'Revokes the session of the cookie and clears the cookie.',
  })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiOkResponse({ type: SignedOut })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'session.invalid (the cookie is cleared) or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'request.csrf or access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async signOutOfSession(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SignedOut> {
    const result = await this.signOut.execute(context, {});
    const outcome = result.ok ? result.value : adminFailure(response, result.error);
    if (result.ok) {
      response.setHeader('Set-Cookie', clearedSessionCookie('admin', context.market.marketId));
    }
    return this.settle('identity.admin-sign-out', context, outcome);
  }

  @Get('session')
  @ReadsSession()
  @ApiOperation({
    summary: 'The signed-in admin account and the session',
    description:
      'Ids, the role and its keys, whether the second factor is active, the email and name, ' +
      'the session lifetimes and the CSRF token of the session. Not cached.',
  })
  @ApiOkResponse({ type: AdminSessionSummary })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'session.invalid (the cookie is cleared) or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async session(
    @Call() context: CallContext,
    @SessionCsrfToken() csrfToken: string | null,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AdminSessionSummary> {
    const result = await this.describeActor.execute(context, {});
    let outcome: AdminSessionSummary | HttpException;
    if (!result.ok) outcome = adminFailure(response, result.error);
    else {
      const summary = result.value;
      if (csrfToken === null || summary.population !== 'admin' || summary.displayName === null) {
        outcome = fail(ACCESS_DENIED_STATUS['access.denied'], 'access.denied');
      } else {
        response.setHeader('Cache-Control', 'no-store');
        outcome = {
          accountId: summary.accountId,
          population: 'admin',
          roleId: summary.roleId,
          permissionKeys: [...summary.permissionKeys],
          secondFactorActive: summary.secondFactorActive,
          lastSignInAt: summary.lastSignInAt,
          email: summary.email,
          displayName: summary.displayName,
          timezone: summary.timezone,
          locale: summary.locale,
          session: summary.session,
          csrfToken,
        };
      }
    }
    this.settle(
      'identity.admin-session',
      context,
      outcome instanceof HttpException ? outcome : { code: 'described' },
    );
    return outcome as AdminSessionSummary;
  }

  /** Logs the outcome code with the correlation id, then answers or throws. */
  private settle<T extends object>(
    msg: string,
    context: CallContext,
    outcome: T | HttpException,
  ): T {
    this.#logger.log({
      msg,
      outcome:
        outcome instanceof HttpException
          ? (outcome.getResponse() as { code: string }).code
          : ((outcome as { code?: string }).code ?? 'ok'),
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (outcome instanceof HttpException) throw outcome;
    return outcome;
  }
}
