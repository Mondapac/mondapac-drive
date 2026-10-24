import type { MarketId } from '@mondapac-drive/shared-kernel';

/**
 * Everything about tracking that differs by Market: the `tracking` section of
 * `config/markets/<CODE>.json`, read through the platform's MarketRegistry.
 */
export interface TrackingSettings {
  readonly marketId: MarketId;
  readonly ping: {
    readonly maxAgeSeconds: number;
    readonly maxFutureSkewSeconds: number;
    readonly minIntervalSeconds: number;
    readonly maxAccuracyMetres: number;
    readonly maxSpeedKmh: number;
  };
  readonly livePositionTtlSeconds: number;
  readonly breadcrumbRetentionDays: number;
  readonly trackingLinkTtlHours: number;
  readonly streamIntervalSeconds: number;
  readonly nearestCouriers: { readonly maxRadiusMetres: number; readonly maxResults: number };
  /** How long one road ETA is reused before routing is asked again. */
  readonly etaRefreshSeconds: number;
}
