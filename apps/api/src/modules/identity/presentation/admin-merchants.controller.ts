import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Logger,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBody,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { parseId } from '@mondapac-drive/shared-kernel';
import type { CallContext, Id } from '@mondapac-drive/shared-kernel';
import type { Request, Response } from 'express';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { CreateMerchant } from '../application/use-cases/create-merchant.use-case';
import {
  ReinstateMerchant,
  SuspendMerchant,
} from '../application/use-cases/change-merchant-state.use-case';
import { ListMerchants } from '../application/use-cases/list-merchants.use-case';
import {
  IssueMerchantApiKey,
  ListMerchantApiKeys,
  RevokeMerchantApiKey,
} from '../application/use-cases/merchant-api-keys.use-case';
import { InviteCourier } from '../application/use-cases/invite-courier.use-case';
import { adminBody, adminClient } from './admin.answer';
import {
  AdminApiKeyIssued,
  AdminApiKeyList,
  AdminApiKeyRevoked,
  AdminCourierInvitationIssued,
  AdminCourierInviteRequest,
  AdminCreateMerchantRequest,
  AdminIssueApiKeyRequest,
  AdminMerchantCreated,
  AdminMerchantList,
  AdminMerchantStateChanged,
} from './admin-merchants.dto';
import { ApiErrorBody } from './api-error.dto';
import { fail, outcomeOf } from './http-body';

/**
 * The HTTP status of each refusal of the merchant and courier routes (identity design 5.2): an
 * unknown or malformed id is 404, a state that refuses the change 409.
 */
export const ADMIN_MERCHANT_STATUS: Readonly<Record<string, number>> = Object.freeze({
  'validation.failed': 400,
  'merchant.unknown': 404,
  'api-key.unknown': 404,
  'merchant.already-suspended': 409,
  'merchant.already-active': 409,
  'merchant.suspended': 409,
  'account.exists': 409,
  'invitation.already-pending': 409,
  'request.throttled': 429,
  'request.busy': 503,
  'access.unavailable': 503,
});

type Refusal = {
  readonly code: string;
  readonly fields?: readonly unknown[];
  readonly retryAfterSeconds?: number;
};

function refusal(error: Refusal, response?: Response): HttpException {
  const status =
    ADMIN_MERCHANT_STATUS[error.code] ??
    ACCESS_DENIED_STATUS[error.code as keyof typeof ACCESS_DENIED_STATUS] ??
    500;
  if (error.fields !== undefined) return fail(status, error.code, { fields: error.fields });
  if (error.retryAfterSeconds !== undefined) {
    response?.setHeader('Retry-After', String(error.retryAfterSeconds));
    return fail(status, error.code, { retryAfterSeconds: error.retryAfterSeconds });
  }
  return fail(status, error.code);
}

/** A path id: malformed answers as an unknown resource, byte-identical to a missing one (5.2). */
function pathId<K extends string>(raw: string, unknown: string): Id<K> | HttpException {
  const parsed = parseId<K>(raw);
  return parsed.ok ? parsed.value : refusal({ code: unknown });
}

/** A closed, empty JSON body (`{}`) for an action route. */
function emptyBody(request: Request, body: unknown): HttpException | null {
  const input = adminBody(request, body, [] as const);
  return input instanceof HttpException ? input : null;
}

const MERCHANT_PARAM = { name: 'merchantId', description: 'The merchant. A UUID v7.' };
const KEY_PARAM = { name: 'keyId', description: 'The API key. A UUID v7.' };
const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };
const ERRORS = [400, 401, 403, 404, 409, 415, 429, 503].map((status) => ({
  status,
  type: ApiErrorBody,
}));

/** Every error answer of these routes, in the format of identity design 5.2. */
function ApiErrors(): MethodDecorator {
  return (target, key, descriptor) => {
    for (const error of ERRORS) ApiResponse(error)(target, key, descriptor);
  };
}

/**
 * Merchants and couriers for operators and dispatchers over HTTP (Drive): create, list, suspend
 * and reinstate merchants; issue, list and revoke their API keys (a key is answered once); and
 * invite couriers. Admin session routes (`@ReadsSession`): an unsafe method needs the CSRF token
 * and the admin panel's origin; JSON only, with a closed body. Thin adapters: each route calls
 * one use case through its gate. Every route logs its outcome code with the correlation id;
 * never a name, an address or a key.
 */
@ApiTags('identity')
@RoutePopulation('admin')
@Controller('identity/admin')
export class AdminMerchantsController {
  readonly #logger = new Logger('AdminMerchantsController');

  constructor(
    private readonly createMerchant: CreateMerchant,
    private readonly listMerchants: ListMerchants,
    private readonly suspendMerchant: SuspendMerchant,
    private readonly reinstateMerchant: ReinstateMerchant,
    private readonly issueApiKey: IssueMerchantApiKey,
    private readonly listApiKeys: ListMerchantApiKeys,
    private readonly revokeApiKey: RevokeMerchantApiKey,
  ) {}

  @Get('merchants')
  @ReadsSession()
  @ApiOperation({ summary: 'The merchants of the Market', description: 'Needs identity.merchant.view.' })
  @ApiOkResponse({ type: AdminMerchantList })
  @ApiErrors()
  async list(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AdminMerchantList> {
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.listMerchants.execute(context, {});
    const outcome: AdminMerchantList | HttpException = result.ok
      ? {
          items: result.value.items.map((row) => ({
            ...row,
            stateChangedAt: row.stateChangedAt.toString(),
            createdAt: row.createdAt.toString(),
          })),
        }
      : refusal(result.error);
    return this.settle('identity.admin-list-merchants', context, outcome);
  }

  @Post('merchants')
  @HttpCode(201)
  @ReadsSession()
  @ApiOperation({
    summary: 'Create a merchant',
    description:
      'Needs identity.merchant.create (protected). Creates the merchant, active, with the ' +
      'integration account its API keys act as. No key is issued.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: AdminCreateMerchantRequest })
  @ApiCreatedResponse({ type: AdminMerchantCreated })
  @ApiErrors()
  async create(
    @Call() context: CallContext,
    @Req() request: Request,
    @Body() body: unknown,
  ): Promise<AdminMerchantCreated> {
    const input = adminBody(request, body, ['name'] as const);
    let outcome: AdminMerchantCreated | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.createMerchant.execute(context, { name: input.name });
      outcome = result.ok
        ? { code: result.value.code, merchantId: result.value.merchantId }
        : refusal(result.error);
    }
    return this.settle('identity.admin-create-merchant', context, outcome);
  }

  @Post('merchants/:merchantId/suspend')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Suspend a merchant',
    description:
      'Needs identity.merchant.suspend (protected). Every API key of the merchant is revoked in ' +
      'the same step, so it can book nothing more.',
  })
  @ApiParam(MERCHANT_PARAM)
  @ApiHeader(CSRF)
  @ApiOkResponse({ type: AdminMerchantStateChanged })
  @ApiErrors()
  async suspend(
    @Call() context: CallContext,
    @Req() request: Request,
    @Param('merchantId') rawMerchantId: string,
    @Body() body: unknown,
  ): Promise<AdminMerchantStateChanged> {
    const outcome = await this.onMerchant(request, rawMerchantId, body, (merchantId) =>
      this.suspendMerchant.execute(context, { merchantId }),
    );
    return this.settle('identity.admin-suspend-merchant', context, outcome);
  }

  @Post('merchants/:merchantId/reinstate')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Reinstate a suspended merchant',
    description:
      'Needs identity.merchant.suspend (protected). Revoked keys stay revoked: issue new ones.',
  })
  @ApiParam(MERCHANT_PARAM)
  @ApiHeader(CSRF)
  @ApiOkResponse({ type: AdminMerchantStateChanged })
  @ApiErrors()
  async reinstate(
    @Call() context: CallContext,
    @Req() request: Request,
    @Param('merchantId') rawMerchantId: string,
    @Body() body: unknown,
  ): Promise<AdminMerchantStateChanged> {
    const outcome = await this.onMerchant(request, rawMerchantId, body, (merchantId) =>
      this.reinstateMerchant.execute(context, { merchantId }),
    );
    return this.settle('identity.admin-reinstate-merchant', context, outcome);
  }

  @Get('merchants/:merchantId/api-keys')
  @ReadsSession()
  @ApiOperation({
    summary: "A merchant's live API keys",
    description: 'Needs identity.merchant.view. Never a key: its label and times only.',
  })
  @ApiParam(MERCHANT_PARAM)
  @ApiOkResponse({ type: AdminApiKeyList })
  @ApiErrors()
  async keys(
    @Call() context: CallContext,
    @Res({ passthrough: true }) response: Response,
    @Param('merchantId') rawMerchantId: string,
  ): Promise<AdminApiKeyList> {
    response.setHeader('Cache-Control', 'no-store');
    const merchantId = pathId<'Merchant'>(rawMerchantId, 'merchant.unknown');
    let outcome: AdminApiKeyList | HttpException;
    if (merchantId instanceof HttpException) outcome = merchantId;
    else {
      const result = await this.listApiKeys.execute(context, { merchantId });
      outcome = result.ok
        ? {
            items: result.value.items.map((row) => ({
              keyId: row.keyId,
              label: row.label,
              createdAt: row.createdAt.toString(),
              lastSeenAt: row.lastSeenAt.toString(),
              expiresAt: row.expiresAt.toString(),
            })),
          }
        : refusal(result.error);
    }
    return this.settle('identity.admin-list-api-keys', context, outcome);
  }

  @Post('merchants/:merchantId/api-keys')
  @HttpCode(201)
  @ReadsSession()
  @ApiOperation({
    summary: 'Issue an API key to a merchant',
    description:
      'Needs identity.merchant-api-key.issue (protected). The key is in this answer only; it is ' +
      'never stored and cannot be shown again. The answer is not cached.',
  })
  @ApiParam(MERCHANT_PARAM)
  @ApiHeader(CSRF)
  @ApiBody({ type: AdminIssueApiKeyRequest })
  @ApiCreatedResponse({ type: AdminApiKeyIssued })
  @ApiErrors()
  async issueKey(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('merchantId') rawMerchantId: string,
    @Body() body: unknown,
  ): Promise<AdminApiKeyIssued> {
    response.setHeader('Cache-Control', 'no-store');
    const merchantId = pathId<'Merchant'>(rawMerchantId, 'merchant.unknown');
    const input = merchantId instanceof HttpException ? merchantId : adminBody(request, body, ['label'] as const);
    let outcome: AdminApiKeyIssued | HttpException;
    if (input instanceof HttpException) outcome = input;
    else {
      const result = await this.issueApiKey.execute(context, {
        merchantId: merchantId as Id<'Merchant'>,
        label: input.label,
      });
      outcome = result.ok
        ? {
            code: result.value.code,
            keyId: result.value.keyId,
            key: result.value.key,
            expiresAt: result.value.expiresAt.toString(),
          }
        : refusal(result.error);
    }
    return this.settle('identity.admin-issue-api-key', context, outcome);
  }

  @Post('merchants/:merchantId/api-keys/:keyId/revoke')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: "Revoke one of a merchant's API keys",
    description: 'Needs identity.merchant-api-key.issue (protected). Takes effect at once.',
  })
  @ApiParam(MERCHANT_PARAM)
  @ApiParam(KEY_PARAM)
  @ApiHeader(CSRF)
  @ApiOkResponse({ type: AdminApiKeyRevoked })
  @ApiErrors()
  async revokeKey(
    @Call() context: CallContext,
    @Req() request: Request,
    @Param('merchantId') rawMerchantId: string,
    @Param('keyId') rawKeyId: string,
    @Body() body: unknown,
  ): Promise<AdminApiKeyRevoked> {
    const merchantId = pathId<'Merchant'>(rawMerchantId, 'merchant.unknown');
    const keyId = pathId<'Session'>(rawKeyId, 'api-key.unknown');
    let outcome: AdminApiKeyRevoked | HttpException;
    const refused = emptyBody(request, body);
    if (refused !== null) outcome = refused;
    else if (merchantId instanceof HttpException) outcome = merchantId;
    else if (keyId instanceof HttpException) outcome = keyId;
    else {
      const result = await this.revokeApiKey.execute(context, { merchantId, keyId });
      outcome = result.ok
        ? { code: result.value.code, keyId: result.value.keyId }
        : refusal(result.error);
    }
    return this.settle('identity.admin-revoke-api-key', context, outcome);
  }

  private async onMerchant(
    request: Request,
    rawMerchantId: string,
    body: unknown,
    run: (
      merchantId: Id<'Merchant'>,
    ) => Promise<
      | { ok: true; value: { code: AdminMerchantStateChanged['code']; merchantId: string } }
      | { ok: false; error: Refusal }
    >,
  ): Promise<AdminMerchantStateChanged | HttpException> {
    const refused = emptyBody(request, body);
    if (refused !== null) return refused;
    const merchantId = pathId<'Merchant'>(rawMerchantId, 'merchant.unknown');
    if (merchantId instanceof HttpException) return merchantId;
    const result = await run(merchantId);
    return result.ok
      ? { code: result.value.code, merchantId: result.value.merchantId }
      : refusal(result.error);
  }

  private settle<T extends object>(msg: string, context: CallContext, outcome: T | HttpException): T {
    this.#logger.log({
      msg,
      outcome: outcome instanceof HttpException ? outcomeOf(outcome) : 'ok',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (outcome instanceof HttpException) throw outcome;
    return outcome;
  }
}

/**
 * Courier onboarding for dispatchers over HTTP (Drive): the invitation. Disabling and enabling a
 * courier are on the admin team routes (`couriers/:accountId/disable`, `.../enable`).
 */
@ApiTags('identity')
@RoutePopulation('admin')
@Controller('identity/admin')
export class AdminCouriersController {
  readonly #logger = new Logger('AdminCouriersController');

  constructor(private readonly inviteCourier: InviteCourier) {}

  @Post('couriers/invitations')
  @HttpCode(201)
  @ReadsSession()
  @ApiOperation({
    summary: 'Invite a courier',
    description:
      'Needs identity.courier-account.invite. The courier role is given on acceptance. One ' +
      'pending invitation per address; a stale one is replaced. The mail follows shortly.',
  })
  @ApiHeader(CSRF)
  @ApiBody({ type: AdminCourierInviteRequest })
  @ApiCreatedResponse({ type: AdminCourierInvitationIssued })
  @ApiErrors()
  async invite(
    @Call() context: CallContext,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ): Promise<AdminCourierInvitationIssued> {
    const input = adminBody(request, body, ['email'] as const);
    const client = input instanceof HttpException ? input : adminClient(request);
    let outcome: AdminCourierInvitationIssued | HttpException;
    if (input instanceof HttpException) outcome = input;
    else if (client instanceof HttpException) outcome = client;
    else {
      const result = await this.inviteCourier.execute(context, {
        email: input.email,
        origin: client.origin,
      });
      outcome = result.ok
        ? { code: result.value.code, invitationId: result.value.invitationId }
        : refusal(result.error, response);
    }
    this.#logger.log({
      msg: 'identity.admin-invite-courier',
      outcome: outcomeOf(outcome instanceof HttpException ? outcome : { code: outcome.code }),
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    if (outcome instanceof HttpException) throw outcome;
    return outcome;
  }
}
