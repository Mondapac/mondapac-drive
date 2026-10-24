import { Body, Controller, Get, HttpCode, HttpException, Param, Post, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  parseId,
  type MarketContext,
  type Money,
  type Result,
} from '@mondapac-drive/shared-kernel';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { Market } from '../../../platform/market-context/market.decorator';
import { CreateDelivery } from '../application/create-delivery';
import { GetDelivery, type DeliveryFailure } from '../application/get-delivery';
import { QuoteDelivery } from '../application/quote-delivery';
import { RecordDeliveryEvent } from '../application/record-delivery-event';
import type { DeliveryState } from '../domain/delivery';
import type { DeliveryQuote } from '../domain/pricing';
import { createDeliveryBody, deliveryEventBody, quoteBody } from './delivery.schemas';

/** The status of each refusal; any other code is a broken domain rule (422). */
const STATUS: Readonly<Record<string, number>> = Object.freeze({
  'delivery.not-found': 404,
  'delivery.conflict': 409,
  'quote.price-changed': 409,
});

function fail(status: number, code: string, details?: object): HttpException {
  return new HttpException({ statusCode: status, code, ...(details ? { details } : {}) }, status);
}

function parsed<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof ZodError) {
      throw fail(400, 'validation.failed', {
        fields: error.issues
          .slice(0, 10)
          .map((issue) => ({ path: issue.path.join('.'), code: issue.code })),
      });
    }
    throw error;
  }
}

function answer<T>(result: Result<T, DeliveryFailure>): T {
  if (result.ok) return result.value;
  throw fail(STATUS[result.error.code] ?? 422, result.error.code, {
    message: result.error.message,
  });
}

const moneyBody = (value: Money) => ({ amount: value.amount.toString(), currency: value.currency });

function quoteBodyOf(quote: DeliveryQuote) {
  return {
    vehicle: quote.vehicle,
    distanceMetres: quote.distanceMetres,
    breakdown: {
      base: moneyBody(quote.breakdown.base),
      distance: moneyBody(quote.breakdown.distance),
      coldChain: moneyBody(quote.breakdown.coldChain),
      scheduledDiscount: moneyBody(quote.breakdown.scheduledDiscount),
    },
    total: moneyBody(quote.total),
    tax: moneyBody(quote.tax),
  };
}

function present(delivery: DeliveryState) {
  return {
    ...delivery,
    quote: quoteBodyOf(delivery.quote),
    window: delivery.window && {
      start: delivery.window.start.toString(),
      end: delivery.window.end.toString(),
    },
    createdAt: delivery.createdAt.toString(),
    history: delivery.history.map((entry) => ({ ...entry, at: entry.at.toString() })),
  };
}

/**
 * Merchant- and courier-facing delivery API, scoped to the request's Market (`x-market-id`, which
 * the OpenAPI document adds to every market-scoped operation).
 * Authentication (merchant API keys, courier and dispatcher sessions) arrives with identity;
 * until then this API must not be exposed outside a developer machine.
 */
@ApiTags('delivery')
@Controller('delivery')
export class DeliveryController {
  constructor(
    private readonly quoteDelivery: QuoteDelivery,
    private readonly createDelivery: CreateDelivery,
    private readonly recordEvent: RecordDeliveryEvent,
    private readonly getDelivery: GetDelivery,
  ) {}

  @Post('quotes')
  @HttpCode(200)
  @ApiOperation({ summary: 'Price a delivery without booking it' })
  async quote(@Market() market: MarketContext, @Body() body: unknown) {
    const input = parsed(() => quoteBody.parse(body));
    const { quote, serviceArea } = answer(await this.quoteDelivery.execute(market, input));
    return { serviceArea: serviceArea.code, ...quoteBodyOf(quote) };
  }

  @Post('deliveries')
  @ApiOperation({
    summary: 'Book a delivery',
    description: 'Idempotent on (merchantId, externalReference): a retry answers 200.',
  })
  async create(
    @Market() market: MarketContext,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const input = parsed(() => createDeliveryBody.parse(body));
    const { delivery, created } = answer(await this.createDelivery.execute(market, input));
    res.status(created ? 201 : 200);
    return present(delivery);
  }

  @Get('deliveries/:id')
  @ApiOperation({ summary: 'A delivery with its history' })
  async get(@Market() market: MarketContext, @Param('id') id: string) {
    const deliveryId = parseId<'Delivery'>(id);
    if (!deliveryId.ok) throw fail(404, 'delivery.not-found');
    return present(answer(await this.getDelivery.execute(market, deliveryId.value)));
  }

  @Post('deliveries/:id/events')
  @HttpCode(200)
  @ApiOperation({ summary: 'Record what happened to a delivery' })
  async event(@Market() market: MarketContext, @Param('id') id: string, @Body() body: unknown) {
    const deliveryId = parseId<'Delivery'>(id);
    if (!deliveryId.ok) throw fail(404, 'delivery.not-found');
    const event = parsed(() => deliveryEventBody.parse(body));
    return present(answer(await this.recordEvent.execute(market, deliveryId.value, event)));
  }
}
