import {
  Controller,
  Headers,
  HttpCode,
  HttpException,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { MarketContext } from '@mondapac-drive/shared-kernel';
import type { Request } from 'express';
import { MarketFromPath } from '../../../platform/http/market-from-path.decorator';
import { Market } from '../../../platform/market-context/market.decorator';
import { RoutePopulation } from '../../../platform/call-context/route-population.decorator';
import { HandleProviderWebhook } from '../application/use-cases/handle-provider-webhook.use-case';

/**
 * The payment provider's webhook (Stripe), one URL per Market: `/payouts/<MARKET>/provider-webhook`.
 * The provider cannot send `x-market-id`, so the Market comes from the path. No caller identity:
 * the signature over the raw body is the authentication, and the body is read only once it holds.
 * Answers 200 for an event handled, ignored or seen before (the provider stops retrying), 400 for
 * a bad signature or body. Not in the public API description.
 */
@ApiExcludeController()
@MarketFromPath()
// Anonymous: no @ReadsSession. Server to server like a merchant integration: the merchant
// population's origin rule lets a request without Origin or Sec-Fetch-Site through.
@RoutePopulation('merchant')
@Controller('payouts/:market/provider-webhook')
export class ProviderWebhookController {
  constructor(private readonly webhook: HandleProviderWebhook) {}

  @Post()
  @HttpCode(200)
  async receive(
    @Market() market: MarketContext,
    @Req() request: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<{ readonly received: true }> {
    const raw = request.rawBody;
    if (raw === undefined) throw refused('payouts.webhook-payload-invalid');
    const result = await this.webhook.run(market, raw, signature);
    if (!result.ok) {
      throw result.error.code.startsWith('payouts.webhook-')
        ? refused(result.error.code)
        : new HttpException({ statusCode: 422, code: result.error.code }, 422);
    }
    return { received: true };
  }
}

function refused(code: string): HttpException {
  return new HttpException({ statusCode: 400, code }, 400);
}
