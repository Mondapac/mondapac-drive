import { Body, Controller, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import { marketId } from '@mondapac-drive/shared-kernel';
import type { Response } from 'express';
import { CreateDelivery } from '../application/create-delivery.js';
import { GetDelivery } from '../application/get-delivery.js';
import { QuoteDelivery } from '../application/quote-delivery.js';
import { RecordDeliveryEvent } from '../application/record-delivery-event.js';
import type { DeliveryState } from '../domain/delivery.js';
import { createDeliveryBody, deliveryEventBody, quoteBody } from './delivery.schemas.js';

/**
 * Merchant- and courier-facing delivery API. Every route is scoped to one Market.
 * Authentication (merchant API keys, courier sessions) is the next slice; until then this API
 * must not be exposed outside a developer machine.
 */
@Controller('v1/markets/:market')
export class DeliveryController {
  constructor(
    private readonly quoteDelivery: QuoteDelivery,
    private readonly createDelivery: CreateDelivery,
    private readonly recordEvent: RecordDeliveryEvent,
    private readonly getDelivery: GetDelivery,
  ) {}

  @Post('quotes')
  @HttpCode(200)
  async quote(@Param('market') market: string, @Body() body: unknown) {
    const input = quoteBody.parse(body);
    const { quote, serviceArea } = await this.quoteDelivery.execute({
      ...input,
      marketId: marketId(market),
    });
    return { serviceArea: serviceArea.code, ...quote };
  }

  @Post('deliveries')
  async create(
    @Param('market') market: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const input = createDeliveryBody.parse(body);
    const { delivery, created } = await this.createDelivery.execute({
      ...input,
      marketId: marketId(market),
    });
    res.status(created ? 201 : 200);
    return present(delivery);
  }

  @Get('deliveries/:id')
  async get(@Param('market') market: string, @Param('id') id: string) {
    return present(await this.getDelivery.execute(marketId(market), id));
  }

  @Post('deliveries/:id/events')
  @HttpCode(200)
  async event(@Param('market') market: string, @Param('id') id: string, @Body() body: unknown) {
    const event = deliveryEventBody.parse(body);
    return present(await this.recordEvent.execute(marketId(market), id, event));
  }
}

function present(delivery: DeliveryState) {
  return {
    ...delivery,
    window: delivery.window && {
      start: delivery.window.start.toISOString(),
      end: delivery.window.end.toISOString(),
    },
    createdAt: delivery.createdAt.toISOString(),
    history: delivery.history.map((entry) => ({ ...entry, at: entry.at.toISOString() })),
  };
}
