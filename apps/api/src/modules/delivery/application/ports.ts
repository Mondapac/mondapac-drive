import type { GeoPoint, MarketId } from '@mondapac-drive/shared-kernel';
import type { DeliveryState } from '../domain/delivery.js';
import type { MarketDeliverySettings } from '../domain/market-settings.js';

export interface DeliveryRepository {
  findById(marketId: MarketId, id: string): Promise<DeliveryState | undefined>;
  findByExternalReference(
    marketId: MarketId,
    merchantId: string,
    externalReference: string,
  ): Promise<DeliveryState | undefined>;
  /** Inserts version 1, or updates when the stored version is `version - 1`; else throws. */
  save(delivery: DeliveryState): Promise<void>;
}
export const DELIVERY_REPOSITORY = Symbol('DeliveryRepository');

/** Road distance between two points, in metres. */
export interface DistanceProvider {
  roadDistanceMetres(from: GeoPoint, to: GeoPoint): Promise<number>;
}
export const DISTANCE_PROVIDER = Symbol('DistanceProvider');

/** The delivery settings of the Markets this deployment hosts. */
export interface MarketSettingsProvider {
  /** Throws `market.not-hosted` for a Market this deployment does not serve. */
  get(marketId: MarketId): MarketDeliverySettings;
}
export const MARKET_SETTINGS = Symbol('MarketSettingsProvider');

export class ConcurrentModificationError extends Error {
  constructor(id: string) {
    super(`Delivery ${id} was changed by someone else; reload and try again`);
    this.name = 'ConcurrentModificationError';
  }
}
