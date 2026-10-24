import { Body, Controller, Get, HttpCode, HttpException, Param, Post, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  parseId,
  type CallContext,
  type Id,
  type Money,
  type Result,
} from '@mondapac-drive/shared-kernel';
import type { Response } from 'express';
import { ZodError } from 'zod';
import { ACCESS_DENIED_STATUS } from '../../../platform/authz';
import { Call } from '../../../platform/call-context/call-context.decorator';
import { CSRF_HEADER } from '../../../platform/call-context/csrf';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import {
  CancelDelivery,
  DispatchDelivery,
  ViewDelivery,
} from '../application/use-cases/admin-deliveries.use-case';
import { BookDelivery } from '../application/use-cases/book-delivery.use-case';
import {
  ReportAssignmentEvent,
  ViewAssignment,
} from '../application/use-cases/courier-deliveries.use-case';
import { CancelBooking, ViewBooking } from '../application/use-cases/merchant-deliveries.use-case';
import { QuoteDelivery, type DeliveryFailure } from '../application/use-cases/quote-delivery.use-case';
import type { DeliveryState } from '../domain/delivery';
import type { DeliveryQuote } from '../domain/pricing';
import {
  cancelBody,
  courierReportBody,
  createDeliveryBody,
  dispatchBody,
  quoteBody,
} from './delivery.schemas';

/** The status of each refusal; any other code is a broken domain rule (422). */
const STATUS: Readonly<Record<string, number>> = Object.freeze({
  'delivery.not-found': 404,
  'delivery.conflict': 409,
  'delivery.event-not-allowed': 403,
  'quote.price-changed': 409,
  ...ACCESS_DENIED_STATUS,
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

function answer<T>(result: Result<T, DeliveryFailure | { readonly code: string }>): T {
  if (result.ok) return result.value;
  const { error } = result;
  const message = 'message' in error ? error.message : undefined;
  throw fail(STATUS[error.code] ?? 422, error.code, message ? { message } : undefined);
}

/** A path id: a malformed one answers as a missing delivery. */
function deliveryIdOf(raw: string): Id<'Delivery'> {
  const parsedId = parseId<'Delivery'>(raw);
  if (!parsedId.ok) throw fail(404, 'delivery.not-found');
  return parsedId.value;
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

const CSRF = { name: CSRF_HEADER, required: true, description: 'The CSRF token of the session' };

/**
 * The merchant's delivery API: what the marketplace's carrier integration calls with a merchant
 * API key (`Authorization: Bearer <key>`), scoped to the request's Market (`x-market-id`). The
 * merchant is always the key's: a key quotes, books, reads and cancels only its own merchant's
 * deliveries, and another merchant's delivery answers 404 as a missing one.
 */
@ApiTags('delivery')
@ApiBearerAuth()
@RoutePopulation('merchant')
@Controller('delivery')
export class MerchantDeliveryController {
  constructor(
    private readonly quoteDelivery: QuoteDelivery,
    private readonly bookDelivery: BookDelivery,
    private readonly viewBooking: ViewBooking,
    private readonly cancelBooking: CancelBooking,
  ) {}

  @Post('quotes')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({ summary: 'Price a delivery without booking it' })
  async quote(@Call() context: CallContext, @Body() body: unknown) {
    const input = parsed(() => quoteBody.parse(body));
    const { quote, serviceArea } = answer(await this.quoteDelivery.execute(context, input));
    return { serviceArea: serviceArea.code, ...quoteBodyOf(quote) };
  }

  @Post('deliveries')
  @ReadsSession()
  @ApiOperation({
    summary: 'Book a delivery',
    description:
      "Idempotent on the merchant and externalReference: a retry answers 200. The merchant is " +
      "the API key's.",
  })
  async create(
    @Call() context: CallContext,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const input = parsed(() => createDeliveryBody.parse(body));
    const { delivery, created } = answer(await this.bookDelivery.execute(context, input));
    res.status(created ? 201 : 200);
    return present(delivery);
  }

  @Get('deliveries/:id')
  @ReadsSession()
  @ApiOperation({ summary: "One of the merchant's deliveries, with its history" })
  async get(@Call() context: CallContext, @Param('id') id: string) {
    const deliveryId = deliveryIdOf(id);
    return present(answer(await this.viewBooking.execute(context, { deliveryId })));
  }

  @Post('deliveries/:id/cancel')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({ summary: "Cancel one of the merchant's deliveries before pickup" })
  async cancel(@Call() context: CallContext, @Param('id') id: string, @Body() body: unknown) {
    const deliveryId = deliveryIdOf(id);
    const { reason } = parsed(() => cancelBody.parse(body));
    return present(answer(await this.cancelBooking.execute(context, { deliveryId, reason })));
  }
}

/**
 * The courier app's delivery API (`Authorization: Bearer <session token>`): the courier reads and
 * reports on deliveries assigned to it only.
 */
@ApiTags('delivery')
@ApiBearerAuth()
@RoutePopulation('courier')
@Controller('delivery/courier')
export class CourierDeliveryController {
  constructor(
    private readonly viewAssignment: ViewAssignment,
    private readonly reportEvent: ReportAssignmentEvent,
  ) {}

  @Get('deliveries/:id')
  @ReadsSession()
  @ApiOperation({ summary: 'A delivery assigned to the courier' })
  async get(@Call() context: CallContext, @Param('id') id: string) {
    const deliveryId = deliveryIdOf(id);
    return present(answer(await this.viewAssignment.execute(context, { deliveryId })));
  }

  @Post('deliveries/:id/events')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({
    summary: 'Report on an assigned delivery',
    description:
      'Arrival, pickup (with the cold-chain reading), delivery (with proof), a failure (with a ' +
      'reason) and the return.',
  })
  async event(@Call() context: CallContext, @Param('id') id: string, @Body() body: unknown) {
    const deliveryId = deliveryIdOf(id);
    const report = parsed(() => courierReportBody.parse(body));
    return present(answer(await this.reportEvent.execute(context, { deliveryId, report })));
  }
}

/**
 * The admin panel's delivery API for operators and dispatchers (the admin session cookie; an
 * unsafe method needs the CSRF token): read any delivery of the Market, dispatch, cancel.
 */
@ApiTags('delivery')
@RoutePopulation('admin')
@Controller('delivery/admin')
export class AdminDeliveryController {
  constructor(
    private readonly viewDelivery: ViewDelivery,
    private readonly dispatchDelivery: DispatchDelivery,
    private readonly cancelDelivery: CancelDelivery,
  ) {}

  @Get('deliveries/:id')
  @ReadsSession()
  @ApiOperation({ summary: 'A delivery of the Market, with its history' })
  async get(@Call() context: CallContext, @Param('id') id: string) {
    const deliveryId = deliveryIdOf(id);
    return present(answer(await this.viewDelivery.execute(context, { deliveryId })));
  }

  @Post('deliveries/:id/dispatch')
  @HttpCode(200)
  @ReadsSession()
  @ApiHeader(CSRF)
  @ApiOperation({ summary: 'Open dispatch, assign a courier with a vehicle, or unassign' })
  async dispatch(@Call() context: CallContext, @Param('id') id: string, @Body() body: unknown) {
    const deliveryId = deliveryIdOf(id);
    const event = parsed(() => dispatchBody.parse(body));
    return present(answer(await this.dispatchDelivery.execute(context, { deliveryId, event })));
  }

  @Post('deliveries/:id/cancel')
  @HttpCode(200)
  @ReadsSession()
  @ApiHeader(CSRF)
  @ApiOperation({ summary: 'Cancel a delivery before pickup' })
  async cancel(@Call() context: CallContext, @Param('id') id: string, @Body() body: unknown) {
    const deliveryId = deliveryIdOf(id);
    const { reason } = parsed(() => cancelBody.parse(body));
    return present(answer(await this.cancelDelivery.execute(context, { deliveryId, reason })));
  }
}
