import type { MarketId } from '@mondapac-drive/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { DispatchSettingsProvider } from '../application/ports';
import type { DispatchSettings } from '../domain/dispatch-settings';

/**
 * {@link DispatchSettingsProvider} over the `dispatch` section of `config/markets/<CODE>.json`,
 * validated at start-up by the platform's Market configuration.
 */
export class ConfigDispatchSettingsProvider implements DispatchSettingsProvider {
  readonly #settings = new Map<MarketId, DispatchSettings>();

  constructor(private readonly markets: MarketRegistry) {}

  get(marketId: MarketId): DispatchSettings {
    const cached = this.#settings.get(marketId);
    if (cached !== undefined) return cached;
    const settings: DispatchSettings = Object.freeze({
      marketId,
      ...this.markets.get(marketId).dispatch,
    });
    this.#settings.set(marketId, settings);
    return settings;
  }
}
