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
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { parseId, type MarketContext } from '@mondapac-drive/shared-kernel';
import { concatMap, from, map, take, timer, type Observable } from 'rxjs';
import { Market } from '../../../platform/market-context/market.decorator';
import { DeliveryTrail } from '../application/use-cases/delivery-trail.use-case';
import { LastKnownPosition } from '../application/use-cases/last-known-position.use-case';
import { NearestCouriers } from '../application/use-cases/nearest-couriers.use-case';
import { RecordLocationPing } from '../application/use-cases/record-location-ping.use-case';
import type { Breadcrumb } from '../domain/breadcrumb';
import type { LivePosition, NearbyCourier } from '../domain/live-position';
import { answer, fail, parsed } from './tracking-http';
import { nearestQuery, pingBody } from './tracking.schemas';

/** The dispatcher map refreshes this often and closes after half an hour, like the tracking page. */
const MAP_REFRESH_MS = 5000;
const MAP_MAX_EVENTS = 360;

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

/**
 * Courier location ingestion and the dispatcher's live map and trails.
 *
 * NOT REGISTERED in `TrackingModule` until identity (work package 2) merges: every route here
 * reads or writes live location, which is personal data, and needs a courier session (pings,
 * with the courier id taken from the session, not the path) or a dispatcher session (the rest).
 * Registering it before then would ship unauthenticated personal data; the module test checks
 * that it is not registered.
 */
@ApiTags('tracking')
@Controller('tracking')
export class TrackingOperationsController {
  constructor(
    private readonly recordPing: RecordLocationPing,
    private readonly nearestCouriers: NearestCouriers,
    private readonly lastKnownPosition: LastKnownPosition,
    private readonly deliveryTrail: DeliveryTrail,
  ) {}

  @Post('couriers/:courierId/pings')
  @HttpCode(202)
  @ApiOperation({ summary: "Record a courier's location ping" })
  async ping(
    @Market() market: MarketContext,
    @Param('courierId') courierId: string,
    @Body() body: unknown,
  ) {
    const input = parsed(() => pingBody.parse(body));
    return answer(await this.recordPing.perform(market, { ...input, courierId }));
  }

  @Get('couriers/nearest')
  @ApiOperation({ summary: 'Couriers with a fresh position near a point, nearest first' })
  async nearest(@Market() market: MarketContext, @Query() query: unknown) {
    const input = parsed(() => nearestQuery.parse(query));
    const found = await this.nearestCouriers.perform(
      market,
      { lat: input.lat, lng: input.lng },
      input.radiusM,
      input.limit,
      input.serviceArea === undefined ? {} : { serviceArea: input.serviceArea },
    );
    return { couriers: found.map(nearbyBody) };
  }

  @Get('couriers/:courierId/position')
  @ApiOperation({ summary: "A courier's latest fresh position" })
  async position(@Market() market: MarketContext, @Param('courierId') courierId: string) {
    const position = await this.lastKnownPosition.perform(market, courierId);
    if (position === undefined) throw fail(404, 'tracking.position-not-found');
    return positionBody(position);
  }

  @Get('deliveries/:deliveryId/trail')
  @ApiOperation({ summary: "A delivery's breadcrumb trail" })
  async trail(@Market() market: MarketContext, @Param('deliveryId') id: string) {
    const deliveryId = parseId<'Delivery'>(id);
    if (!deliveryId.ok) throw fail(404, 'tracking.delivery-not-found');
    const crumbs = answer(await this.deliveryTrail.perform(market, deliveryId.value));
    return { points: crumbs.map(crumbBody) };
  }

  @Sse('map/stream')
  @ApiOperation({ summary: 'Server-sent events of the couriers near a point (dispatcher map)' })
  map(@Market() market: MarketContext, @Query() query: unknown): Observable<MessageEvent> {
    const input = parsed(() => nearestQuery.parse(query));
    const options = input.serviceArea === undefined ? {} : { serviceArea: input.serviceArea };
    return timer(0, MAP_REFRESH_MS).pipe(
      take(MAP_MAX_EVENTS),
      concatMap(() =>
        from(
          this.nearestCouriers.perform(
            market,
            { lat: input.lat, lng: input.lng },
            input.radiusM,
            input.limit,
            options,
          ),
        ),
      ),
      map((found) => ({ type: 'couriers', data: { couriers: found.map(nearbyBody) } })),
    );
  }
}
