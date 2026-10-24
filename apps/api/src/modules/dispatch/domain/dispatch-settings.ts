import type { MarketId } from '@mondapac-drive/shared-kernel';

/**
 * Everything about dispatch that differs by Market: the `dispatch` section of
 * `config/markets/<CODE>.json`, read through the platform's MarketRegistry.
 */
export interface DispatchSettings {
  readonly marketId: MarketId;
  /** How long a courier has to accept an offer. */
  readonly offerTimeoutSeconds: number;
  /** How many couriers receive an offer at the same time; 1 offers one courier at a time. */
  readonly waveSize: number;
  /** Waves sent before the job is exhausted and handed to a dispatcher. */
  readonly maxRounds: number;
  /** A scheduled delivery opens for dispatch this long before its window starts. */
  readonly scheduledLeadMinutes: number;
  /** Couriers farther than this from the pickup are not offered the delivery. */
  readonly searchRadiusMetres: number;
  /** The most nearby couriers considered for one wave. */
  readonly candidateLimit: number;
}
