import { Body, Controller, HttpCode, HttpException, Logger, Post, Put, Req, Res } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiForbiddenResponse,
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
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { RateLimit } from '../../../platform/rate-limit/rate-limit.decorator';
import { AcceptCourierInvitation } from '../application/use-cases/accept-courier-invitation.use-case';
import { ChangePassword } from '../application/use-cases/change-password.use-case';
import { RequestPasswordReset } from '../application/use-cases/request-password-reset.use-case';
import { ResetPassword } from '../application/use-cases/reset-password.use-case';
import { SignInCourier } from '../application/use-cases/sign-in-courier.use-case';
import { SignOut } from '../application/use-cases/sign-out.use-case';
import { adminBody, adminClient, adminFailure } from './admin.answer';
import { ApiErrorBody, SignedOut } from './api-error.dto';
import {
  CourierAcceptInvitationRequest,
  CourierInvitationAccepted,
  CourierSignedIn,
  CourierSignInRequest,
} from './courier.dto';
import { outcomeOf } from './http-body';
import {
  answerChangePassword,
  answerPasswordResetEmail,
  answerResetPassword,
} from './password.answer';
import {
  ChangePasswordRequest,
  CourierPasswordChanged,
  PasswordChanged,
  PasswordResetAccepted,
  PasswordResetEmailRequest,
  ResetPasswordRequest,
} from './password.dto';

const BEARER = 'session.invalid or access.unauthenticated';

/**
 * The courier app's account routes over HTTP (Drive). Courier sessions are bearer sessions: the
 * token is answered in the body of a sign-in and sent as `Authorization: Bearer`, never a
 * cookie, so the session routes need no CSRF token. JSON only, with a closed body.
 *
 * - `POST sign-in` (anonymous): email and password; the token in the answer.
 * - `POST invitations/accept` (anonymous): the invitation's token, a name and a password; no
 *   session opens.
 * - `POST password-reset-email` and `POST reset-password` (anonymous): the link flow of the
 *   other populations; a reset ends every session of the account.
 * - `POST sign-out` and `PUT password` read the courier session; a change answers the session's
 *   new token, which replaces the old one.
 *
 * Every route logs its outcome code with the correlation id; never the email, the password, a
 * token or the address.
 */
@ApiTags('identity')
@RoutePopulation('courier')
@Controller('identity/courier')
export class CourierSessionController {
  readonly #logger = new Logger('CourierSessionController');

  constructor(
    private readonly signInCourier: SignInCourier,
    private readonly acceptInvitation: AcceptCourierInvitation,
    private readonly requestReset: RequestPasswordReset,
    private readonly resetPassword: ResetPassword,
    private readonly changePassword: ChangePassword,
    private readonly signOut: SignOut,
  ) {}

  @Post('sign-in')
  @HttpCode(200)
  @RateLimit('anonymous-identity')
  @ApiOperation({
    summary: "A courier's sign-in",
    description:
      'An unknown address, a wrong password and an account of another type or Market all ' +
      'answer credentials.invalid. The answer is not cached.',
  })
  @ApiBody({ type: CourierSignInRequest })
  @ApiOkResponse({ type: CourierSignedIn })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed (details.fields)' })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: 'credentials.invalid' })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'account.disabled' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiTooManyRequestsResponse({
    type: ApiErrorBody,
    description: 'request.throttled (details.retryAfterSeconds, Retry-After)',
  })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'request.busy or access.unavailable' })
  async signIn(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<CourierSignedIn> {
    const input = adminBody(request, body, ['email', 'password'] as const);
    const client = input instanceof HttpException ? input : adminClient(request);
    let outcome: CourierSignedIn | HttpException;
    if (input instanceof HttpException) outcome = input;
    else if (client instanceof HttpException) outcome = client;
    else {
      const result = await this.signInCourier.execute(context, { ...input, client });
      response.setHeader('Cache-Control', 'no-store');
      outcome = result.ok ? result.value : adminFailure(response, result.error);
    }
    return this.settle('identity.courier-sign-in', context, outcome);
  }

  @Post('invitations/accept')
  @HttpCode(200)
  @RateLimit('anonymous-identity')
  @ApiOperation({
    summary: "Accept a courier's invitation",
    description:
      'Every refusal of the token (unknown, used, revoked, expired or of another Market) answers ' +
      'invitation.rejected. No session opens: the courier signs in from the app.',
  })
  @ApiBody({ type: CourierAcceptInvitationRequest })
  @ApiOkResponse({ type: CourierInvitationAccepted })
  @ApiBadRequestResponse({
    type: ApiErrorBody,
    description: 'validation.failed, password.rejected or invitation.rejected',
  })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody, description: 'request.throttled' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'request.busy or access.unavailable' })
  async accept(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<CourierInvitationAccepted> {
    const input = adminBody(request, body, ['token', 'displayName', 'password'] as const);
    const client = input instanceof HttpException ? input : adminClient(request);
    let outcome: CourierInvitationAccepted | HttpException;
    if (input instanceof HttpException) outcome = input;
    else if (client instanceof HttpException) outcome = client;
    else {
      const result = await this.acceptInvitation.execute(context, { ...input, client });
      outcome = result.ok ? result.value : adminFailure(response, result.error);
    }
    return this.settle('identity.courier-accept-invitation', context, outcome);
  }

  @Post('password-reset-email')
  @HttpCode(202)
  @RateLimit('anonymous-identity')
  @ApiOperation({
    summary: 'Ask for a password reset link',
    description: 'One answer for every address: whether a mail is sent is never told.',
  })
  @ApiBody({ type: PasswordResetEmailRequest })
  @ApiAcceptedResponse({ type: PasswordResetAccepted })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: 'validation.failed' })
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
      'courier',
      this.requestReset,
    );
    return this.settle('identity.courier-password-reset-email', context, outcome);
  }

  @Post('reset-password')
  @HttpCode(200)
  @RateLimit('anonymous-identity')
  @ApiOperation({
    summary: 'Set a new password with a reset link',
    description: 'Every session of the account ends.',
  })
  @ApiBody({ type: ResetPasswordRequest })
  @ApiOkResponse({ type: PasswordChanged })
  @ApiBadRequestResponse({
    type: ApiErrorBody,
    description: 'validation.failed, password.rejected or link.rejected',
  })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody, description: 'request.throttled' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'request.busy or access.unavailable' })
  async reset(
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
      'courier',
      this.resetPassword,
    );
    return this.settle('identity.courier-reset-password', context, outcome);
  }

  @Put('password')
  @HttpCode(200)
  @ReadsSession()
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Change the signed-in courier's password",
    description:
      'Every other session of the account ends; this one gets a new token, in the answer, which ' +
      'replaces the old one.',
  })
  @ApiBody({ type: ChangePasswordRequest })
  @ApiOkResponse({ type: CourierPasswordChanged })
  @ApiBadRequestResponse({
    type: ApiErrorBody,
    description: 'validation.failed, password.rejected or password.current-incorrect',
  })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: BEARER })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody, description: 'request.throttled' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'request.busy or access.unavailable' })
  async changeOwnPassword(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<CourierPasswordChanged> {
    const outcome = await answerChangePassword(
      context,
      request,
      response,
      body,
      'courier',
      this.changePassword,
    );
    return this.settle('identity.courier-change-password', context, outcome);
  }

  @Post('sign-out')
  @HttpCode(200)
  @ReadsSession()
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Sign out of the current courier session' })
  @ApiOkResponse({ type: SignedOut })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: BEARER })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async signOutOfSession(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SignedOut> {
    const result = await this.signOut.execute(context, {});
    const outcome = result.ok ? result.value : adminFailure(response, result.error);
    return this.settle('identity.courier-sign-out', context, outcome);
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
