import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiHeader, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
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
  ListDeliveries,
  ViewDelivery,
  type DeliverySummary,
} from '../application/use-cases/admin-deliveries.use-case';
import { BookDelivery } from '../application/use-cases/book-delivery.use-case';
import {
  ReportAssignmentEvent,
  ViewAssignment,
} from '../application/use-cases/courier-deliveries.use-case';
import { CancelBooking, ViewBooking } from '../application/use-cases/merchant-deliveries.use-case';
import {
  MAX_PROOF_PHOTO_BYTES,
  UploadProofPhoto,
} from '../application/use-cases/upload-proof-photo.use-case';
import {
  QuoteDelivery,
  type DeliveryFailure,
} from '../application/use-cases/quote-delivery.use-case';
import type { DeliveryState } from '../domain/delivery';
import type { DeliveryQuote } from '../domain/pricing';
import {
  cancelBody,
  courierReportBody,
  createDeliveryBody,
  deliveryListQuery,
  dispatchBody,
  quoteBody,
} from './delivery.schemas';
import { BearerSessionRequiredGuard } from './bearer-session-required.guard';

/** The status of each refusal; any other code is a broken domain rule (422). */
const STATUS: Readonly<Record<string, number>> = Object.freeze({
  'delivery.not-found': 404,
  'delivery.conflict': 409,
  'delivery.event-not-allowed': 403,
  'quote.price-changed': 409,
  'address.geocoding-unavailable': 503,
  'delivery.pin-wrong': 422,
  'delivery.pin-locked': 423,
  'proof-photo.too-large': 413,
  'proof-photo.unsupported-type': 415,
  'proof-photo.limit-reached': 409,
  'proof-photo.storage-unavailable': 503,
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

/**
 * Seconds a client should wait before retrying a refusal that passes on its own. The marketplace
 * honours `Retry-After` (carrier contract, docs/delivery/carrier-api.md); a geocoding lookup that
 * timed out keeps running and fills the cache, so a short wait is enough.
 */
const RETRY_AFTER_SECONDS: Readonly<Record<string, number>> = Object.freeze({
  'address.geocoding-unavailable': 2,
});

function answer<T>(
  result: Result<T, DeliveryFailure | { readonly code: string }>,
  res?: Response,
): T {
  if (result.ok) return result.value;
  const { error } = result;
  const retryAfter = RETRY_AFTER_SECONDS[error.code];
  if (retryAfter !== undefined) res?.setHeader('Retry-After', String(retryAfter));
  const message = 'message' in error ? error.message : undefined;
  throw fail(STATUS[error.code] ?? 422, error.code, message ? { message } : undefined);
}

/** A path id: a malformed one answers as a missing delivery. */
function deliveryIdOf(raw: string): Id<'Delivery'> {
  const parsedId = parseId<'Delivery'>(raw);
  if (!parsedId.ok) throw fail(404, 'delivery.not-found');
  return parsedId.value;
}

/** The `before` cursor of the list: a malformed one is a bad query, not a missing delivery. */
function cursorOf(raw: string): Id<'Delivery'> {
  const parsedId = parseId<'Delivery'>(raw.toLowerCase());
  if (!parsedId.ok) {
    throw fail(400, 'validation.failed', { fields: [{ path: 'before', code: 'format' }] });
  }
  return parsedId.value;
}

const moneyBody = (value: Money) => ({ amount: value.amount.toString(), currency: value.currency });

function quoteBodyOf(quote: DeliveryQuote) {
  return {
    vehicle: quote.vehicle,
    distanceMetres: quote.distanceMetres,
    distanceEstimated: quote.distanceEstimated,
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
    exception: delivery.exception ?? null,
    quote: quoteBodyOf(delivery.quote),
    window: delivery.window && {
      start: delivery.window.start.toString(),
      end: delivery.window.end.toString(),
    },
    createdAt: delivery.createdAt.toString(),
    history: delivery.history.map((entry) => ({ ...entry, at: entry.at.toString() })),
  };
}

/** A history entry without the courier: for the merchant and the courier, who see only their own side. */
function withoutCourier(delivery: Pick<ReturnType<typeof present>, 'history'>) {
  return delivery.history.map((entry) => {
    const { courierId: hidden, ...rest } = entry;
    void hidden;
    return rest;
  });
}

/**
 * The merchant's view (Hassan, WP2 review): no courier id, here or in the history. The merchant
 * follows the courier through the tracking link, never by account id.
 */
function presentForMerchant(delivery: DeliveryState) {
  const full = present(delivery);
  // The dispatcher's exception flag is operational: neither the merchant nor the courier sees it.
  const { courierId: hidden, exception: flag, ...rest } = full;
  void hidden;
  void flag;
  return { ...rest, history: withoutCourier(full) };
}

/**
 * The courier's view (Hassan, WP2 review): the job without the merchant's price (only the
 * vehicle and distance of the quote), and no other courier's id in the history.
 */
function presentForCourier(delivery: DeliveryState) {
  const { exception: flag, ...full } = present(delivery);
  void flag;
  return {
    ...full,
    quote: { vehicle: delivery.quote.vehicle, distanceMetres: delivery.quote.distanceMetres },
    history: withoutCourier(full),
  };
}

function presentSummary(delivery: DeliverySummary) {
  return {
    ...delivery,
    exception: delivery.exception ?? null,
    total: moneyBody(delivery.total),
    window: delivery.window && {
      start: delivery.window.start.toString(),
      end: delivery.window.end.toString(),
    },
    createdAt: delivery.createdAt.toString(),
  };
}

/** Rows of the delivery list when the query names no limit. */
const DEFAULT_DELIVERY_PAGE = 50;

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
  async quote(
    @Call() context: CallContext,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const input = parsed(() => quoteBody.parse(body));
    const { quote, serviceArea } = answer(await this.quoteDelivery.execute(context, input), res);
    return { serviceArea: serviceArea.code, ...quoteBodyOf(quote) };
  }

  @Post('deliveries')
  @ReadsSession()
  @ApiOperation({
    summary: 'Book a delivery',
    description:
      'Idempotent on the merchant and externalReference: a retry answers 200. The merchant is ' +
      "the API key's.",
  })
  async create(
    @Call() context: CallContext,
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const input = parsed(() => createDeliveryBody.parse(body));
    const { delivery, created } = answer(await this.bookDelivery.execute(context, input), res);
    res.status(created ? 201 : 200);
    return presentForMerchant(delivery);
  }

  @Get('deliveries/:id')
  @ReadsSession()
  @ApiOperation({ summary: "One of the merchant's deliveries, with its history" })
  async get(@Call() context: CallContext, @Param('id') id: string) {
    const deliveryId = deliveryIdOf(id);
    return presentForMerchant(answer(await this.viewBooking.execute(context, { deliveryId })));
  }

  @Post('deliveries/:id/cancel')
  @HttpCode(200)
  @ReadsSession()
  @ApiOperation({ summary: "Cancel one of the merchant's deliveries before pickup" })
  async cancel(@Call() context: CallContext, @Param('id') id: string, @Body() body: unknown) {
    const deliveryId = deliveryIdOf(id);
    const { reason } = parsed(() => cancelBody.parse(body));
    return presentForMerchant(
      answer(await this.cancelBooking.execute(context, { deliveryId, reason })),
    );
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
    private readonly uploadProofPhoto: UploadProofPhoto,
  ) {}

  @Get('deliveries/:id')
  @ReadsSession()
  @ApiOperation({ summary: 'A delivery assigned to the courier' })
  async get(@Call() context: CallContext, @Param('id') id: string) {
    const deliveryId = deliveryIdOf(id);
    return presentForCourier(answer(await this.viewAssignment.execute(context, { deliveryId })));
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
    return presentForCourier(
      answer(await this.reportEvent.execute(context, { deliveryId, report })),
    );
  }

  @Post('deliveries/:id/proof-photos')
  @HttpCode(201)
  @ReadsSession()
  // Guards run before interceptors: no byte is buffered without a signed-in courier. The body
  // stops at one file part named `photo` of at most MAX_PROOF_PHOTO_BYTES (413 beyond).
  @UseGuards(BearerSessionRequiredGuard)
  @UseInterceptors(
    // No storage option: multer keeps the part in memory (its default without a destination).
    FileInterceptor('photo', {
      limits: { fileSize: MAX_PROOF_PHOTO_BYTES, files: 1, fields: 0, parts: 1 },
    }),
  )
  @ApiOperation({
    summary: 'Upload a proof-of-delivery photo',
    description:
      'Multipart, one JPEG or PNG part named `photo` (at most 5 MB), while the parcel is with ' +
      'the courier. Answers `{ photoRef }`, which `delivered` takes as ' +
      "`proof: { kind: 'photo', photoRef }`.",
  })
  async proofPhoto(
    @Call() context: CallContext,
    @Param('id') id: string,
    @UploadedFile() photo: { readonly buffer?: Buffer } | undefined,
  ) {
    const deliveryId = deliveryIdOf(id);
    if (photo?.buffer === undefined) {
      throw fail(400, 'validation.failed', { fields: [{ path: 'photo', code: 'required' }] });
    }
    return answer(
      await this.uploadProofPhoto.execute(context, { deliveryId, bytes: photo.buffer }),
    );
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
    private readonly listDeliveries: ListDeliveries,
    private readonly viewDelivery: ViewDelivery,
    private readonly dispatchDelivery: DispatchDelivery,
    private readonly cancelDelivery: CancelDelivery,
  ) {}

  @Get('deliveries')
  @ReadsSession()
  @ApiOperation({
    summary: 'The deliveries of the Market, newest first',
    description:
      "Summaries without the stops' addresses or contacts. Filters: `status` (comma-separated), " +
      '`merchantId`, `courierId`, `attention=true` (an exception flag or a failed delivery); paged with `before` (the `next` of the previous page) and ' +
      `\`limit\` (1 to 100, default ${DEFAULT_DELIVERY_PAGE}). Not cached.`,
  })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'merchantId', required: false })
  @ApiQuery({ name: 'courierId', required: false })
  @ApiQuery({ name: 'attention', required: false, enum: ['true', 'false'] })
  @ApiQuery({ name: 'before', required: false })
  @ApiQuery({ name: 'limit', required: false })
  async list(
    @Call() context: CallContext,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { status, merchantId, courierId, attention, before, limit } = parsed(() =>
      deliveryListQuery.parse(query),
    );
    const page = answer(
      await this.listDeliveries.execute(context, {
        ...(status === undefined ? {} : { statuses: status }),
        ...(merchantId === undefined ? {} : { merchantId: merchantId.toLowerCase() }),
        ...(courierId === undefined ? {} : { courierId: courierId.toLowerCase() }),
        ...(attention === true ? { attention } : {}),
        ...(before === undefined ? {} : { before: cursorOf(before) }),
        limit: limit ?? DEFAULT_DELIVERY_PAGE,
      }),
    );
    res.setHeader('Cache-Control', 'no-store');
    return { items: page.items.map(presentSummary), next: page.next };
  }

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
