import { Inject, Injectable } from '@nestjs/common';
import type { GeoPoint, MarketContext } from '@mondapac-drive/shared-kernel';
import type { NearbyCourier } from '../../domain/live-position';
import {
  LIVE_POSITION_STORE,
  TRACKING_SETTINGS,
  type LivePositionStore,
  type TrackingSettingsProvider,
} from '../ports';

export interface NearestCouriersOptions {
  /** Only couriers whose latest ping named this service area. */
  readonly serviceArea?: string;
}

/**
 * The couriers with a fresh position near a point, nearest first: for dispatch (work package
 * 07) and the dispatcher map. The radius and the count are capped by the Market's settings.
 */
@Injectable()
export class NearestCouriers {
  constructor(
    @Inject(LIVE_POSITION_STORE) private readonly positions: LivePositionStore,
    @Inject(TRACKING_SETTINGS) private readonly settings: TrackingSettingsProvider,
  ) {}

  perform(
    market: MarketContext,
    point: GeoPoint,
    radiusMetres: number,
    limit: number,
    options: NearestCouriersOptions = {},
  ): Promise<NearbyCourier[]> {
    const caps = this.settings.get(market.marketId).nearestCouriers;
    const radius = Math.min(Math.max(1, Math.floor(radiusMetres)), caps.maxRadiusMetres);
    const count = Math.min(Math.max(1, Math.floor(limit)), caps.maxResults);
    return this.positions.nearest(market.marketId, point, radius, count, options.serviceArea);
  }
}
