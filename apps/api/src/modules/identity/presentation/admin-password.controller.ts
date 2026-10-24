import { Body, Controller, HttpCode, HttpException, Logger, Post, Req, Res } from '@nestjs/common';
import {
  ApiAcceptedResponse,
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
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { RateLimit } from '../../../platform/rate-limit/rate-limit.decorator';
import { ChangePassword } from '../application/use-cases/change-password.use-case';
import { RequestPasswordReset } from '../application/use-cases/request-password-reset.use-case';
import { ResetPassword } from '../application/use-cases/reset-password.use-case';
import { AdminChangePasswordRequest } from './admin.dto';
import { ApiErrorBody } from './api-error.dto';
import {
  answerChangePassword,
  answerPasswordResetEmail,
  answerResetPassword,
} from './password.answer';
import {
  PasswordChanged,
  PasswordChangedInSession,
  PasswordResetAccepted,
  PasswordResetEmailRequest,
  ResetPasswordRequest,
} from './password.dto';
import { outcomeOf } from './http-body';

/**
 * Admin password reset and change over HTTP (identity design 3.5, 3.7, 6.5; slice 7b item A and
 * Hassan I2 (b)). The same use cases and answers as the other populations, for `admin`:
 *
 * - `POST password-reset-email` and `POST reset-password` (anonymous). A reset clears only the
 *   two sign-in counters of the address, never `second-factor.account`, and never removes or
 *   bypasses the second factor: the next sign-in still asks for a code (Hassan I-4, I2 (a)).
 * - `POST change-password` behind the admin session and its CSRF token: the current password,
 *   the new one **and a code** (app or recovery code). On success the session continues with a
 *   new cookie (never persistent) and CSRF token, every other session ends, a notice is mailed.
 *
 * Every route logs its outcome code with the correlation id; never the email, a password, a code,
 * a token or the address.
 */
@ApiTags('identity')
@RoutePopulation('admin')
@Controller('identity/admin')
export class AdminPasswordController {
  readonly #logger = new Logger('AdminPasswordController');

  constructor(
    private readonly requestPasswordReset: RequestPasswordReset,
    private readonly resetPassword: ResetPassword,
    private readonly changePassword: ChangePassword,
  ) {}

  @Post('password-reset-email')
  @HttpCode(202)
  @RateLimit('anonymous-identity')
  @ApiOperation({
    summary: 'Ask for a link to reset the password of an admin account',
    description:
      'The same answer whether or not the address has an admin account in this Market. Only ' +
      'an active account gets the mail, with a link valid for 60 minutes.',
  })
  @ApiBody({ type: PasswordResetEmailRequest })
  @ApiAcceptedResponse({ type: PasswordResetAccepted })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'request.csrf (a refused origin)' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async passwordResetEmail(
    @Call() context: CallContext,
    @Req() request: Request,
    @Body() body: unknown,
  ): Promise<PasswordResetAccepted> {
    const outcome = await answerPasswordResetEmail(
      context,
      request,
      body,
      'admin',
      this.requestPasswordReset,
    );
    return this.settle('identity.admin-password-reset-email', context, outcome);
  }

  @Post('reset-password')
  @HttpCode(200)
  @RateLimit('anonymous-identity')
  @ApiOperation({
    summary: 'Choose a new admin password with the mailed reset link',
    description:
      "The token from the link's fragment and the new password. Every session ends; the " +
      'second factor stays, so the next sign-in still asks for a code.',
  })
  @ApiBody({ type: ResetPasswordRequest })
  @ApiOkResponse({ type: PasswordChanged })
  @ApiBadRequestResponse({
    type: ApiErrorBody,
    description: 'validation.failed, password.rejected (details.rule) or link.rejected',
  })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'request.csrf (a refused origin)' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody, description: 'request.throttled' })
  @ApiServiceUnavailableResponse({
    type: ApiErrorBody,
    description: 'request.busy or access.unavailable',
  })
  async resetPasswordWithLink(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<PasswordChanged> {
    const outcome = await answerResetPassword(
      context,
      request,
      response,
      body,
      'admin',
      this.resetPassword,
    );
    return this.settle('identity.admin-reset-password', context, outcome);
  }

  @Post('change-password')
  @HttpCode(200)
  @ReadsSession()
  @RateLimit('anonymous-identity')
  @ApiOperation({
    summary: 'Change the password of the signed-in admin account',
    description:
      'The current password, the new one and a code from the app (or a recovery code). Wrong ' +
      'passwords count as failed sign-ins, wrong codes on the second-factor counter.',
  })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiBody({ type: AdminChangePasswordRequest })
  @ApiOkResponse({
    type: PasswordChangedInSession,
    headers: { 'Set-Cookie': { description: 'The admin session cookie with the new token' } },
  })
  @ApiBadRequestResponse({
    type: ApiErrorBody,
    description:
      'validation.failed, password.rejected (details.rule), password.current-incorrect or ' +
      'second-factor.invalid',
  })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'session.invalid (the cookie is cleared) or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'request.csrf or access.denied' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiTooManyRequestsResponse({
    type: ApiErrorBody,
    description: 'request.throttled or second-factor.locked (details.retryAfterSeconds)',
  })
  @ApiServiceUnavailableResponse({
    type: ApiErrorBody,
    description: 'request.busy or access.unavailable',
  })
  async changeOwnPassword(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<PasswordChangedInSession> {
    const outcome = await answerChangePassword(
      context,
      request,
      response,
      body,
      'admin',
      this.changePassword,
    );
    return this.settle('identity.admin-change-password', context, outcome);
  }

  private settle<T extends { code: string }>(
    msg: string,
    context: CallContext,
    outcome: T | HttpException,
  ): T {
    this.#logger.log({
      msg,
      outcome: outcomeOf(outcome),
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (outcome instanceof HttpException) throw outcome;
    return outcome;
  }
}
