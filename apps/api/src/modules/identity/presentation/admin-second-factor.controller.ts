import { Body, Controller, HttpCode, HttpException, Logger, Post, Req, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
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
import { CSRF_HEADER, csrfTokenFor } from '../../../platform/call-context/csrf';
import { clearedSessionCookie, sessionCookie } from '../../../platform/call-context/session-cookie';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { RateLimit } from '../../../platform/rate-limit/rate-limit.decorator';
import { AcceptAdminInvitation } from '../application/use-cases/accept-admin-invitation.use-case';
import { ConfirmSecondFactorEnrolment } from '../application/use-cases/confirm-second-factor-enrolment.use-case';
import { CompleteSecondFactorReplacement } from '../application/use-cases/complete-second-factor-replacement.use-case';
import { RegenerateRecoveryCodes } from '../application/use-cases/regenerate-recovery-codes.use-case';
import { StartSecondFactorReplacement } from '../application/use-cases/start-second-factor-replacement.use-case';
import { StartAdminInvitationAcceptance } from '../application/use-cases/start-admin-invitation-acceptance.use-case';
import { StartSecondFactorEnrolment } from '../application/use-cases/start-second-factor-enrolment.use-case';
import { adminBody, adminClient, adminFailure } from './admin.answer';
import {
  AdminAcceptInvitationRequest,
  AdminCodeRequest,
  AdminEnrolmentConfirmRequest,
  AdminEnrolmentRequest,
  AdminEnrolmentStarted,
  AdminInvitationEnrolmentReady,
  AdminInvitationTokenRequest,
  AdminNewDeviceCodeRequest,
  AdminReplacementCompleted,
  AdminReplacementStarted,
  RecoveryCodesShown,
} from './admin.dto';
import { ApiErrorBody } from './api-error.dto';

const ANONYMOUS_REFUSALS =
  'validation.failed (details.fields), link.rejected, challenge.rejected, ' +
  'invitation.rejected, invitation.enrolment-expired, second-factor.invalid or ' +
  'password.rejected (details.rule)';

/**
 * The admin's second factor over HTTP (identity design 3.4, 3.6, 7; HF6; AC 11, AC 22; slice
 * 7b items D, E, F). Every answer that shows a secret or recovery codes is `no-store`.
 *
 * Anonymous (the token in the body binds the account; the stricter per-origin limit):
 * - `POST second-factor/enrolment`: the mailed enrolment link's token and the password; a new
 *   secret and a challenge token. `POST second-factor/enrolment/confirm`: the challenge token and
 *   the first code; the factor is active and the recovery codes are shown once. Every session of
 *   the account has ended; the admin then signs in.
 * - `POST invitation/enrolment`: the invitation token; a new secret with its tag and expiry,
 *   nothing stored. `POST invitation/accept`: the token, the name, the password, the secret's
 *   three parts and the first code; the account and its factor exist, the codes are shown once.
 *
 * Behind the admin session cookie and its CSRF token (`own-resources`):
 * - `POST second-factor/replacement` (a code or recovery code): a new device's secret waits.
 * - `POST second-factor/replacement/confirm` (the new device's code): the swap; the session
 *   continues with a new cookie and CSRF token, every other session ends, a notice is mailed.
 * - `POST second-factor/recovery-codes` (a code or recovery code): ten new codes, shown once.
 *
 * Each route logs its outcome code with the correlation id; never a token, a secret, a code, a
 * password, a name or an address.
 */
@ApiTags('identity')
@RoutePopulation('admin')
@Controller('identity/admin')
export class AdminSecondFactorController {
  readonly #logger = new Logger('AdminSecondFactorController');

  constructor(
    private readonly startEnrolment: StartSecondFactorEnrolment,
    private readonly confirmEnrolment: ConfirmSecondFactorEnrolment,
    private readonly startReplacement: StartSecondFactorReplacement,
    private readonly completeReplacement: CompleteSecondFactorReplacement,
    private readonly regenerateCodes: RegenerateRecoveryCodes,
    private readonly startAcceptance: StartAdminInvitationAcceptance,
    private readonly acceptInvitation: AcceptAdminInvitation,
  ) {}

  @Post('second-factor/enrolment')
  @HttpCode(200)
  @RateLimit('anonymous-identity')
  @ApiOperation({
    summary: 'Start enrolling a second factor from the mailed link',
    description:
      "The link's token and the account's password. Answers a new secret (text and otpauth " +
      'URI, shown once) and a challenge token for the first code. A stale unconfirmed ' +
      'enrolment is replaced; an active factor refuses the link.',
  })
  @ApiBody({ type: AdminEnrolmentRequest })
  @ApiOkResponse({ type: AdminEnrolmentStarted })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: ANONYMOUS_REFUSALS })
  @ApiUnauthorizedResponse({ type: ApiErrorBody, description: 'credentials.invalid' })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'request.csrf (a refused origin)' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody, description: 'request.throttled' })
  @ApiServiceUnavailableResponse({
    type: ApiErrorBody,
    description: 'request.busy or access.unavailable',
  })
  async enrol(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<AdminEnrolmentStarted> {
    const input = adminBody(request, body, ['token', 'password'] as const);
    const client = adminClient(request);
    if (input instanceof HttpException || client instanceof HttpException) {
      return this.refuse(
        'identity.admin-enrolment',
        context,
        input instanceof HttpException ? input : (client as HttpException),
      );
    }
    const result = await this.startEnrolment.execute(context, { ...input, client });
    return this.settle(
      'identity.admin-enrolment',
      context,
      result.ok
        ? this.noStore(response, { ...result.value, expiresAt: result.value.expiresAt.toString() })
        : adminFailure(response, result.error),
    );
  }

  @Post('second-factor/enrolment/confirm')
  @HttpCode(200)
  @RateLimit('anonymous-identity')
  @ApiOperation({
    summary: 'Confirm an enrolment with the first code',
    description:
      'The challenge token and the first code from the app. The factor becomes active, every ' +
      'session of the account ends, and ten recovery codes are shown once.',
  })
  @ApiBody({ type: AdminEnrolmentConfirmRequest })
  @ApiOkResponse({ type: RecoveryCodesShown })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: ANONYMOUS_REFUSALS })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'request.csrf (a refused origin)' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiTooManyRequestsResponse({
    type: ApiErrorBody,
    description: 'second-factor.locked or request.throttled (details.retryAfterSeconds)',
  })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async confirm(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<RecoveryCodesShown> {
    const input = adminBody(request, body, ['challengeToken', 'code'] as const);
    const client = adminClient(request);
    if (input instanceof HttpException || client instanceof HttpException) {
      return this.refuse(
        'identity.admin-enrolment-confirm',
        context,
        input instanceof HttpException ? input : (client as HttpException),
      );
    }
    const result = await this.confirmEnrolment.execute(context, { ...input, client });
    return this.settle(
      'identity.admin-enrolment-confirm',
      context,
      result.ok
        ? this.noStore(response, {
            ...result.value,
            recoveryCodes: [...result.value.recoveryCodes],
          })
        : adminFailure(response, result.error),
    );
  }

  @Post('second-factor/replacement')
  @HttpCode(200)
  @ReadsSession()
  @RateLimit('anonymous-identity')
  @ApiOperation({
    summary: 'Start moving the second factor to a new device',
    description:
      'A code from the current app, or a recovery code. Answers the new secret (shown once); ' +
      'the current app keeps working until the new one confirms.',
  })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiBody({ type: AdminCodeRequest })
  @ApiOkResponse({ type: AdminReplacementStarted })
  @ApiBadRequestResponse({
    type: ApiErrorBody,
    description: 'validation.failed or second-factor.invalid',
  })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'request.csrf or access.denied' })
  @ApiConflictResponse({ type: ApiErrorBody, description: 'second-factor.unavailable' })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody, description: 'second-factor.locked' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async replace(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<AdminReplacementStarted> {
    const input = adminBody(request, body, ['code'] as const);
    if (input instanceof HttpException)
      return this.refuse('identity.admin-replacement', context, input);
    const result = await this.startReplacement.execute(context, input);
    return this.settle(
      'identity.admin-replacement',
      context,
      result.ok ? this.noStore(response, result.value) : adminFailure(response, result.error),
    );
  }

  @Post('second-factor/replacement/confirm')
  @HttpCode(200)
  @ReadsSession()
  @RateLimit('anonymous-identity')
  @ApiOperation({
    summary: 'Confirm the new device with its first code',
    description:
      'A code from the new app. The new secret replaces the old one; this session gets a new ' +
      'token (cookie and CSRF token), every other session ends and a notice is mailed.',
  })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiBody({ type: AdminNewDeviceCodeRequest })
  @ApiOkResponse({
    type: AdminReplacementCompleted,
    headers: { 'Set-Cookie': { description: 'The admin session cookie with the new token' } },
  })
  @ApiBadRequestResponse({
    type: ApiErrorBody,
    description: 'validation.failed or second-factor.invalid',
  })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'session.invalid (the cookie is cleared) or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'request.csrf or access.denied' })
  @ApiConflictResponse({
    type: ApiErrorBody,
    description: 'second-factor.unavailable (nothing waits)',
  })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody, description: 'second-factor.locked' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async confirmReplacement(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<AdminReplacementCompleted> {
    const input = adminBody(request, body, ['code'] as const);
    if (input instanceof HttpException) {
      return this.refuse('identity.admin-replacement-confirm', context, input);
    }
    const result = await this.completeReplacement.execute(context, input);
    if (!result.ok) {
      if (result.error.code === 'session.invalid') {
        response.setHeader('Set-Cookie', clearedSessionCookie('admin', context.market.marketId));
      }
      return this.refuse(
        'identity.admin-replacement-confirm',
        context,
        adminFailure(response, result.error),
      );
    }
    response.setHeader(
      'Set-Cookie',
      sessionCookie('admin', context.market.marketId, result.value.token, null),
    );
    return this.settle(
      'identity.admin-replacement-confirm',
      context,
      this.noStore(response, {
        code: 'second-factor-replaced' as const,
        csrfToken: csrfTokenFor(result.value.token),
      }),
    );
  }

  @Post('second-factor/recovery-codes')
  @HttpCode(200)
  @ReadsSession()
  @RateLimit('anonymous-identity')
  @ApiOperation({
    summary: 'Make ten new recovery codes',
    description:
      'A code from the app, or a recovery code. Every earlier recovery code stops working; ' +
      'the new ones are shown once.',
  })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiBody({ type: AdminCodeRequest })
  @ApiOkResponse({ type: RecoveryCodesShown })
  @ApiBadRequestResponse({
    type: ApiErrorBody,
    description: 'validation.failed or second-factor.invalid',
  })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'request.csrf or access.denied' })
  @ApiConflictResponse({ type: ApiErrorBody, description: 'second-factor.unavailable' })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody, description: 'second-factor.locked' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async recoveryCodes(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<RecoveryCodesShown> {
    const input = adminBody(request, body, ['code'] as const);
    if (input instanceof HttpException) {
      return this.refuse('identity.admin-recovery-codes', context, input);
    }
    const result = await this.regenerateCodes.execute(context, input);
    return this.settle(
      'identity.admin-recovery-codes',
      context,
      result.ok
        ? this.noStore(response, {
            ...result.value,
            recoveryCodes: [...result.value.recoveryCodes],
          })
        : adminFailure(response, result.error),
    );
  }

  @Post('invitation/enrolment')
  @HttpCode(200)
  @RateLimit('anonymous-identity')
  @ApiOperation({
    summary: "Start accepting an admin invitation: the authenticator app's secret",
    description:
      "The invitation's token. Answers a new secret with a tag and an expiry 15 minutes ahead; " +
      'nothing is stored until the acceptance.',
  })
  @ApiBody({ type: AdminInvitationTokenRequest })
  @ApiOkResponse({ type: AdminInvitationEnrolmentReady })
  @ApiBadRequestResponse({
    type: ApiErrorBody,
    description: 'validation.failed or invitation.rejected',
  })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'request.csrf (a refused origin)' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiTooManyRequestsResponse({ type: ApiErrorBody, description: 'request.throttled' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  async invitationEnrolment(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<AdminInvitationEnrolmentReady> {
    const input = adminBody(request, body, ['token'] as const);
    const client = adminClient(request);
    if (input instanceof HttpException || client instanceof HttpException) {
      return this.refuse(
        'identity.admin-invitation-enrolment',
        context,
        input instanceof HttpException ? input : (client as HttpException),
      );
    }
    const result = await this.startAcceptance.execute(context, { ...input, client });
    return this.settle(
      'identity.admin-invitation-enrolment',
      context,
      result.ok
        ? this.noStore(response, { ...result.value, expiresAt: result.value.expiresAt.toString() })
        : adminFailure(response, result.error),
    );
  }

  @Post('invitation/accept')
  @HttpCode(200)
  @RateLimit('anonymous-identity')
  @ApiOperation({
    summary: 'Accept an admin invitation',
    description:
      "The token, the person's name, a password, the secret's three parts and the first code " +
      'from the app. Creates the account with its active second factor and shows ten recovery ' +
      'codes once. No session is opened: the new admin signs in.',
  })
  @ApiBody({ type: AdminAcceptInvitationRequest })
  @ApiOkResponse({ type: RecoveryCodesShown })
  @ApiBadRequestResponse({ type: ApiErrorBody, description: ANONYMOUS_REFUSALS })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'request.csrf (a refused origin)' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiTooManyRequestsResponse({
    type: ApiErrorBody,
    description: 'request.throttled or second-factor.locked (details.retryAfterSeconds)',
  })
  @ApiServiceUnavailableResponse({
    type: ApiErrorBody,
    description: 'request.busy or access.unavailable',
  })
  async accept(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<RecoveryCodesShown> {
    const input = adminBody(request, body, [
      'token',
      'displayName',
      'password',
      'secret',
      'tag',
      'expiresAt',
      'code',
    ] as const);
    const client = adminClient(request);
    if (input instanceof HttpException || client instanceof HttpException) {
      return this.refuse(
        'identity.admin-invitation-accept',
        context,
        input instanceof HttpException ? input : (client as HttpException),
      );
    }
    const result = await this.acceptInvitation.execute(context, { ...input, client });
    return this.settle(
      'identity.admin-invitation-accept',
      context,
      result.ok
        ? this.noStore(response, {
            code: result.value.code,
            recoveryCodes: [...result.value.recoveryCodes],
          })
        : adminFailure(response, result.error),
    );
  }

  /** Logs a refusal's code with the correlation id and throws it. */
  private refuse(msg: string, context: CallContext, failure: HttpException): never {
    return this.settle<never>(msg, context, failure);
  }

  private noStore<T>(response: Response, value: T): T {
    response.setHeader('Cache-Control', 'no-store');
    return value;
  }

  /** Logs the outcome code with the correlation id, then answers or throws. */
  private settle<T>(msg: string, context: CallContext, outcome: T | HttpException): T {
    this.#logger.log({
      msg,
      outcome:
        outcome instanceof HttpException
          ? (outcome.getResponse() as { code: string }).code
          : (outcome as { code: string }).code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (outcome instanceof HttpException) throw outcome;
    return outcome;
  }
}
