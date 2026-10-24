import {
  Body,
  Controller,
  Get,
  HttpCode,
  type MessageEvent,
  Param,
  Post,
  Query,
  Sse,
  SseSignal,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { CallContext } from '@mondapac-drive/shared-kernel';
import {
  concatMap,
  EMPTY,
  finalize,
  from,
  map,
  take,
  takeWhile,
  timer,
  type Observable,
} from 'rxjs';
import { Call } from '../../../platform/call-context/call-context.decorator';
import {
  ReadsSession,
  RoutePopulation,
} from '../../../platform/call-context/route-population.decorator';
import { DeliveryTrail } from '../application/use-cases/delivery-trail.use-case';
import { RecordLocationPing } from '../application/use-cases/record-location-ping.use-case';
import {
  ViewCourierPosition,
  ViewNearbyCouriers,
  type NearbyQuery,
} from '../application/use-cases/view-courier-positions.use-case';
import type { Breadcrumb } from '../domain/breadcrumb';
import type { LivePosition, NearbyCourier } from '../domain/live-position';
import { StreamLimits } from './stream-limits';
import { answer, fail, parsed, refusal } from './tracking-http';
import { nearestQuery, pingBody } from './tracking.schemas';

/** The dispatcher map refreshes this often and closes after half an hour, like the tracking page. */
const MAP_REFRESH_MS = 5000;
const MAP_MAX_EVENTS = 360;
/** Open map streams of one admin, and of this API instance. */
const MAP_STREAMS_PER_ADMIN = 3;
const MAP_STREAMS_PER_INSTANCE = 500;

const positionBody = (position: LivePosition) => ({
  courierId: position.courierId,
  lat: position.point.lat,
  lng: position.point.lng,
  accuracyM: position.accuracyMetres,
  ...(position.headingDegrees === undefined ? {} : { headingDeg: position.headingDegrees }),
  ...(position.speedKmh === undefined ? {} : { speedKmh: position.speedKmh }),
  recordedAt: position.recordedAt.toString(),
  ...(position.serviceAreaCode === undefined ? {} : { serviceArea: position.serviceAreaCode }),
});

const nearbyBody = (nearby: NearbyCourier) => ({
  ...positionBody(nearby.position),
  distanceM: nearby.distanceMetres,
});

const crumbBody = (crumb: Breadcrumb) => ({
  courierId: crumb.courierId,
  lat: crumb.point.lat,
  lng: crumb.point.lng,
  accuracyM: crumb.accuracyMetres,
  recordedAt: crumb.recordedAt.toString(),
});

const nearbyQueryOf = (query: unknown): NearbyQuery => {
  const input = parsed(() => nearestQuery.parse(query));
  return {
    point: { lat: input.lat, lng: input.lng },
    radiusMetres: input.radiusM,
    limit: input.limit,
    ...(input.serviceArea === undefined ? {} : { serviceArea: input.serviceArea }),
  };
};

/** The admin's account id: the key of its map streams. The gate admitted it already. */
function adminKey(context: CallContext): string {
  return context.actor.kind === 'authenticated' ? context.actor.accountId : 'unknown';
}

/**
 * The courier app's location API (`Authorization: Bearer <session token>`): the courier sends
 * batches of its own fixes. The courier is the session's account, never a path or body field.
 */
@ApiTags('tracking')
@ApiBearerAuth()
@RoutePopulation('courier')
@Controller('tracking/courier')
export class CourierTrackingController {
  constructor(private readonly recordPing: RecordLocationPing) {}

  @Post('pings')
  @HttpCode(202)
  @ReadsSession()
  @ApiOperation({
    summary: "Record a batch of the courier's location pings",
    description:
      'At most 20 pings, each checked against the Market (accuracy, speed, age); the latest ' +
      'valid one becomes the live position. 429 `ping.throttled` when the last batch was too ' +
      'recent. Invalid pings of a batch are listed by index, never echoed.',
  })
  async ping(@Call() context: CallContext, @Body() body: unknown) {
    const input = parsed(() => pingBody.parse(body));
    return answer(await this.recordPing.execute(context, input));
  }
}

/**
 * The admin panel's live map for operators and dispatchers (the admin session cookie): couriers
 * near a point, one courier's position, a delivery's trail, and the map's live channel. Every
 * route reads live location, personal data: rule `permissions [tracking.map.view]`.
 */
@ApiTags('tracking')
@RoutePopulation('admin')
@Controller('tracking/admin')
export class DispatcherTrackingController {
  readonly #streams = new StreamLimits(MAP_STREAMS_PER_ADMIN, MAP_STREAMS_PER_INSTANCE);

  constructor(
    private readonly viewNearby: ViewNearbyCouriers,
    private readonly viewPosition: ViewCourierPosition,
    private readonly deliveryTrail: DeliveryTrail,
  ) {}

  @Get('couriers/nearest')
  @ReadsSession()
  @ApiOperation({ summary: 'Couriers with a fresh position near a point, nearest first' })
  async nearest(@Call() context: CallContext, @Query() query: unknown) {
    const found = answer(await this.viewNearby.execute(context, nearbyQueryOf(query)));
    return { couriers: found.map(nearbyBody) };
  }

  @Get('couriers/:courierId/position')
  @ReadsSession()
  @ApiOperation({ summary: "A courier's latest fresh position" })
  async position(@Call() context: CallContext, @Param('courierId') courierId: string) {
    return positionBody(answer(await this.viewPosition.execute(context, { courierId })));
  }

  @Get('deliveries/:deliveryId/trail')
  @ReadsSession()
  @ApiOperation({ summary: "A delivery's breadcrumb trail" })
  async trail(@Call() context: CallContext, @Param('deliveryId') deliveryId: string) {
    const crumbs = answer(await this.deliveryTrail.execute(context, { deliveryId }));
    return { points: crumbs.map(crumbBody) };
  }

  @Sse('map/stream')
  @ReadsSession()
  @ApiOperation({
    summary: 'Server-sent events of the couriers near a point (dispatcher map)',
    description:
      'A `couriers` event every five seconds for half an hour. Each event asks the gate again, ' +
      'so a revoked role ends the stream with one `end` event. At most three streams per admin ' +
      '(429 `tracking.too-many-streams`).',
  })
  async map(
    @Call() context: CallContext,
    @Query() query: unknown,
    @SseSignal() signal: AbortSignal,
  ): Promise<Observable<MessageEvent>> {
    const input = nearbyQueryOf(query);
    // The first read answers a refusal as an HTTP error, before the stream opens.
    const first = await this.viewNearby.execute(context, input);
    if (!first.ok) throw refusal(first.error);
    const release = this.#streams.acquire(adminKey(context));
    if (release === undefined) {
      throw fail(429, 'tracking.too-many-streams', { retryAfterSeconds: 60 });
    }
    // The signal aborts on every end of the response, also when the client left during the
    // first read, before Nest subscribes: the slot is never kept (security review of 06b, M1).
    signal.addEventListener('abort', release, { once: true });
    if (signal.aborted) {
      release();
      return EMPTY;
    }
    return timer(0, MAP_REFRESH_MS).pipe(
      take(MAP_MAX_EVENTS),
      concatMap((tick) =>
        tick === 0 ? from([first]) : from(this.viewNearby.execute(context, input)),
      ),
      takeWhile((result) => result.ok, true),
      map((result) =>
        result.ok
          ? { type: 'couriers', data: { couriers: result.value.map(nearbyBody) } }
          : { type: 'end', data: { code: result.error.code } },
      ),
      // Runs on completion and when the client disconnects (Nest unsubscribes on close).
      finalize(release),
    );
  }
}
