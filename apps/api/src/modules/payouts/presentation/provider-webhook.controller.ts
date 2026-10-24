import {
  Controller,
  Headers,
  HttpCode,
  HttpException,
  Logger,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { CallContext } from '@mondapac-drive/shared-kernel';
import type { Request } from 'express';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { RoutePopulation } from '../../../platform/call-context/route-population.decorator';
import { MarketFromPath } from '../../../platform/http/market-from-path.decorator';
import {
  HandleProviderWebhook,
  RETRY_LATER,
  type WebhookResult,
} from '../application/use-cases/handle-provider-webhook.use-case';

/** The path of the webhook: also where configure-app mounts its larger body limit (L4). */
export const PROVIDER_WEBHOOK_PATH = 'payouts/:market/provider-webhook';

/**
 * The payment provider's webhook (Stripe), one URL per Market: `/payouts/<MARKET>/provider-webhook`.
 * The provider cannot send `x-market-id`, so the Market comes from the path. No caller identity:
 * the signature over the raw body is the authentication, and the body is read only once it holds.
 * Answers 200 for an event handled, ignored or seen before (the provider stops retrying), 400 for
 * a bad signature or body, and 503 for a reversal whose transfer is not on its line yet, so the
 * provider sends it again (security review M2). What operators must look at is logged as a
 * warning, with ids and codes only. Not in the public API description.
 */
@ApiExcludeController()
@MarketFromPath()
// Anonymous: no @ReadsSession. Server to server like a merchant integration: the merchant
// population's origin rule lets a request without Origin or Sec-Fetch-Site through.
@RoutePopulation('merchant')
@Controller(PROVIDER_WEBHOOK_PATH)
export class ProviderWebhookController {
  readonly #logger = new Logger('Payouts');

  constructor(private readonly webhook: HandleProviderWebhook) {}

  @Post()
  @HttpCode(200)
  async receive(
    @Call() context: CallContext,
    @Req() request: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<{ readonly received: true }> {
    const rawBody = request.rawBody;
    if (rawBody === undefined) throw refused(400, 'payouts.webhook-payload-invalid');
    const result = await this.webhook.execute(context, { rawBody, signatureHeader: signature });
    if (!result.ok) {
      const { code } = result.error;
      if (code === RETRY_LATER) {
        this.alert(context, result.error);
        throw refused(503, code);
      }
      throw code.startsWith('payouts.webhook-') ? refused(400, code) : refused(422, code);
    }
    this.alert(context, result.value);
    return { received: true };
  }

  private alert(context: CallContext, result: Omit<WebhookResult, 'outcome'>): void {
    if (result.alert === undefined) return;
    this.#logger.warn({
      msg: `payouts.webhook-${result.alert}`,
      marketId: context.market.marketId,
      ...(result.transferId === undefined ? {} : { transferId: result.transferId }),
      ...(result.lineId === undefined ? {} : { lineId: result.lineId }),
    });
  }
}

function refused(status: number, code: string): HttpException {
  return new HttpException({ statusCode: status, code }, status);
}
