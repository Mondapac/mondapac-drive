import type { MarketId } from '@mondapac-drive/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { TrackingSettingsProvider } from '../application/ports';
import type { TrackingSettings } from '../domain/tracking-settings';

/**
 * {@link TrackingSettingsProvider} over the `tracking` section of `config/markets/<CODE>.json`,
 * validated at start-up by the platform's Market configuration.
 */
export class ConfigTrackingSettingsProvider implements TrackingSettingsProvider {
  readonly #settings = new Map<MarketId, TrackingSettings>();

  constructor(private readonly markets: MarketRegistry) {}

  get(marketId: MarketId): TrackingSettings {
    const cached = this.#settings.get(marketId);
    if (cached !== undefined) return cached;
    const settings: TrackingSettings = Object.freeze({
      marketId,
      ...this.markets.get(marketId).tracking,
    });
    this.#settings.set(marketId, settings);
    return settings;
  }
}
