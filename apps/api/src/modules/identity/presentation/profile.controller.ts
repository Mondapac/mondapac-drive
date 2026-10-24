import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Logger,
  Post,
  Put,
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
  ApiTooManyRequestsResponse,
  ApiTags,
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
import { ChangeDisplayName } from '../application/use-cases/change-display-name.use-case';
import { ChangePanelPreferences } from '../application/use-cases/change-panel-preferences.use-case';
import { ListOwnSessions } from '../application/use-cases/list-own-sessions.use-case';
import { SignOutOtherSessions } from '../application/use-cases/sign-out-other-sessions.use-case';
import { adminBody, adminFailure } from './admin.answer';
import { ApiErrorBody } from './api-error.dto';
import {
  ChangeDisplayNameRequest,
  ChangePanelPreferencesRequest,
  DisplayNameChanged,
  OtherSessionsSignedOut,
  OwnSessions,
  PanelPreferencesChanged,
} from './profile.dto';

/** One route, one answer for both panels: the actor's own display name (profile package). */
async function answerChangeDisplayName(
  logger: Logger,
  msg: string,
  context: CallContext,
  request: Request,
  response: Response,
  body: unknown,
  useCase: ChangeDisplayName,
): Promise<DisplayNameChanged> {
  const input = adminBody(request, body, ['displayName'] as const);
  let outcome: DisplayNameChanged | HttpException;
  if (input instanceof HttpException) outcome = input;
  else {
    const result = await useCase.execute(context, { displayName: input.displayName });
    if (result.ok) {
      response.setHeader('Cache-Control', 'no-store');
      outcome = result.value;
    } else outcome = adminFailure(response, result.error);
  }
  logger.log({
    msg,
    outcome:
      outcome instanceof HttpException ? (outcome.getResponse() as { code: string }).code : 'ok',
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
  if (outcome instanceof HttpException) throw outcome;
  return outcome;
}

/** Same shape for the preferences route: both panels, the actor's own account. */
async function answerChangePreferences(
  logger: Logger,
  msg: string,
  context: CallContext,
  request: Request,
  response: Response,
  body: unknown,
  useCase: ChangePanelPreferences,
): Promise<PanelPreferencesChanged> {
  const input = adminBody(request, body, ['timezone', 'locale'] as const);
  let outcome: PanelPreferencesChanged | HttpException;
  if (input instanceof HttpException) outcome = input;
  else {
    const result = await useCase.execute(context, {
      timezone: input.timezone,
      locale: input.locale,
    });
    if (result.ok) {
      response.setHeader('Cache-Control', 'no-store');
      outcome = result.value;
    } else outcome = adminFailure(response, result.error);
  }
  logger.log({
    msg,
    outcome:
      outcome instanceof HttpException ? (outcome.getResponse() as { code: string }).code : 'ok',
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
  if (outcome instanceof HttpException) throw outcome;
  return outcome;
}

/** The holder's own live sessions, for both panels (profile package 4). Logs codes only. */
async function answerListSessions(
  logger: Logger,
  msg: string,
  context: CallContext,
  response: Response,
  useCase: ListOwnSessions,
): Promise<OwnSessions> {
  const result = await useCase.execute(context, {});
  let outcome: OwnSessions | HttpException;
  if (result.ok) {
    response.setHeader('Cache-Control', 'no-store');
    outcome = { items: result.value.items.map((item) => ({ ...item })) };
  } else outcome = adminFailure(response, result.error);
  logger.log({
    msg,
    outcome:
      outcome instanceof HttpException ? (outcome.getResponse() as { code: string }).code : 'ok',
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
  if (outcome instanceof HttpException) throw outcome;
  return outcome;
}

/** Ends every other session of the holder, for both panels (profile package 4). */
async function answerSignOutOthers(
  logger: Logger,
  msg: string,
  context: CallContext,
  response: Response,
  useCase: SignOutOtherSessions,
): Promise<OtherSessionsSignedOut> {
  const result = await useCase.execute(context, {});
  let outcome: OtherSessionsSignedOut | HttpException;
  if (result.ok) {
    response.setHeader('Cache-Control', 'no-store');
    outcome = result.value;
  } else outcome = adminFailure(response, result.error);
  logger.log({
    msg,
    outcome:
      outcome instanceof HttpException ? (outcome.getResponse() as { code: string }).code : 'ok',
    revokedSessions: outcome instanceof HttpException ? 0 : outcome.revokedSessions,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
  if (outcome instanceof HttpException) throw outcome;
  return outcome;
}

/**
 * The signed-in admin's own profile over HTTP: `PUT profile/display-name`. Reads the admin
 * session cookie and needs its CSRF token. The use case takes the account from the session, so
 * the body names none. Never logs the name.
 */
@ApiTags('identity')
@RoutePopulation('admin')
@Controller('identity/admin')
export class AdminProfileController {
  readonly #logger = new Logger('AdminProfileController');

  constructor(
    private readonly changeDisplayName: ChangeDisplayName,
    private readonly changePreferences: ChangePanelPreferences,
    private readonly listSessions: ListOwnSessions,
    private readonly signOutOthers: SignOutOtherSessions,
  ) {}

  @Put('profile/display-name')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({ summary: 'Change the display name of the signed-in admin account' })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiBody({ type: ChangeDisplayNameRequest })
  @ApiOkResponse({ type: DisplayNameChanged })
  @ApiBadRequestResponse({
    type: ApiErrorBody,
    description: 'validation.failed (details.fields: displayName length or characters)',
  })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'session.invalid (the cookie is cleared) or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'request.csrf or access.denied' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  changeOwnDisplayName(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<DisplayNameChanged> {
    return answerChangeDisplayName(
      this.#logger,
      'identity.admin-change-display-name',
      context,
      request,
      response,
      body,
      this.changeDisplayName,
    );
  }
  @Put('profile/preferences')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({ summary: 'Set the time zone and language of the signed-in admin account' })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiBody({ type: ChangePanelPreferencesRequest })
  @ApiOkResponse({ type: PanelPreferencesChanged })
  @ApiBadRequestResponse({
    type: ApiErrorBody,
    description: 'validation.failed (details.fields: timezone or locale not supported)',
  })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'session.invalid (the cookie is cleared) or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'request.csrf or access.denied' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  changeOwnPreferences(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<PanelPreferencesChanged> {
    return answerChangePreferences(
      this.#logger,
      'identity.admin-change-preferences',
      context,
      request,
      response,
      body,
      this.changePreferences,
    );
  }

  @Get('profile/sessions')
  @ReadsSession()
  @ApiOperation({
    summary: 'The live sessions of the signed-in admin account',
    description:
      'The coarse device and times of each; no session id, token or address. Not cached.',
  })
  @ApiOkResponse({ type: OwnSessions })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'session.invalid (the cookie is cleared) or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  listOwnSessions(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OwnSessions> {
    return answerListSessions(
      this.#logger,
      'identity.admin-list-sessions',
      context,
      response,
      this.listSessions,
    );
  }

  @Post('profile/sessions/sign-out-others')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Sign the signed-in admin account out of every other device',
    description: 'Revokes every session of the account except the current one, which stays.',
  })
  @ApiHeader({ name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' })
  @ApiOkResponse({ type: OtherSessionsSignedOut })
  @ApiTooManyRequestsResponse({
    type: ApiErrorBody,
    description: 'request.throttled (details.retryAfterSeconds; Retry-After)',
  })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'session.invalid (the cookie is cleared) or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'request.csrf or access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  signOutOtherSessions(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OtherSessionsSignedOut> {
    return answerSignOutOthers(
      this.#logger,
      'identity.admin-sign-out-other-sessions',
      context,
      response,
      this.signOutOthers,
    );
  }
}

/**
 * The same routes for a courier, on the courier app's bearer session (`Authorization: Bearer`, no
 * cookie and no CSRF token). No preferences route: the app follows the phone's zone and language.
 */
@ApiTags('identity')
@RoutePopulation('courier')
@Controller('identity/courier')
export class CourierProfileController {
  readonly #logger = new Logger('CourierProfileController');

  constructor(
    private readonly changeDisplayName: ChangeDisplayName,
    private readonly listSessions: ListOwnSessions,
    private readonly signOutOthers: SignOutOtherSessions,
  ) {}

  @Put('profile/display-name')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Change the display name of the signed-in courier account',
    description: 'The name dispatchers see for the courier.',
  })
  @ApiBody({ type: ChangeDisplayNameRequest })
  @ApiOkResponse({ type: DisplayNameChanged })
  @ApiBadRequestResponse({
    type: ApiErrorBody,
    description: 'validation.failed (details.fields: displayName length or characters)',
  })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiUnsupportedMediaTypeResponse({ type: ApiErrorBody, description: 'Not application/json' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  changeOwnDisplayName(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<DisplayNameChanged> {
    return answerChangeDisplayName(
      this.#logger,
      'identity.courier-change-display-name',
      context,
      request,
      response,
      body,
      this.changeDisplayName,
    );
  }

  @Get('profile/sessions')
  @ReadsSession()
  @ApiOperation({
    summary: 'The live sessions of the signed-in courier account',
    description:
      'The coarse device and times of each; no session id, token or address. Not cached.',
  })
  @ApiOkResponse({ type: OwnSessions })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  listOwnSessions(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OwnSessions> {
    return answerListSessions(
      this.#logger,
      'identity.courier-list-sessions',
      context,
      response,
      this.listSessions,
    );
  }

  @Post('profile/sessions/sign-out-others')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Sign the signed-in courier account out of every other device',
    description: 'Revokes every session of the account except the current one, which stays.',
  })
  @ApiOkResponse({ type: OtherSessionsSignedOut })
  @ApiTooManyRequestsResponse({
    type: ApiErrorBody,
    description: 'request.throttled (details.retryAfterSeconds; Retry-After)',
  })
  @ApiUnauthorizedResponse({
    type: ApiErrorBody,
    description: 'session.invalid or access.unauthenticated',
  })
  @ApiForbiddenResponse({ type: ApiErrorBody, description: 'access.denied' })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody, description: 'access.unavailable' })
  signOutOtherSessions(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OtherSessionsSignedOut> {
    return answerSignOutOthers(
      this.#logger,
      'identity.courier-sign-out-other-sessions',
      context,
      response,
      this.signOutOthers,
    );
  }
}
