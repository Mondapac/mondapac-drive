import type { GeoPoint, MarketContext } from '@mondapac-drive/shared-kernel';
import type { LivePosition, NearbyCourier } from '../domain/live-position';
import { isCourierId } from '../domain/location-ping';
import type { LivePositionStore, TrackingSettingsProvider } from './ports';

/** The ports the position reads take. */
export interface PositionDependencies {
  readonly positions: LivePositionStore;
  readonly settings: TrackingSettingsProvider;
}

export interface NearbyQuery {
  readonly point: GeoPoint;
  readonly radiusMetres: number;
  readonly limit: number;
  /** Only couriers whose latest ping named this service area. */
  readonly serviceArea?: string;
}

/** The couriers with a fresh position near a point, nearest first, capped by the Market. */
export function findNearest(
  deps: PositionDependencies,
  market: MarketContext,
  query: NearbyQuery,
): Promise<NearbyCourier[]> {
  const caps = deps.settings.get(market.marketId).nearestCouriers;
  const radius = Math.min(Math.max(1, Math.floor(query.radiusMetres)), caps.maxRadiusMetres);
  const count = Math.min(Math.max(1, Math.floor(query.limit)), caps.maxResults);
  return deps.positions.nearest(market, query.point, radius, count, query.serviceArea);
}

/** A courier's latest fresh position, or undefined once it has expired (the courier is offline). */
export async function findLastKnown(
  deps: PositionDependencies,
  market: MarketContext,
  courierId: string,
): Promise<LivePosition | undefined> {
  if (!isCourierId(courierId)) return undefined;
  return deps.positions.lastKnown(market, courierId);
}
