import type { MarketId } from '@mondapac-drive/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { PayoutSettingsProvider } from '../application/ports';
import type { MarketPayoutSettings } from '../domain/payout-settings';

/**
 * {@link PayoutSettingsProvider} over the platform's Market configuration: the `payouts` section
 * of `config/markets/<CODE>.json`, validated at start-up, with the Market's settlement currency
 * and time zone.
 */
export class ConfigPayoutSettingsProvider implements PayoutSettingsProvider {
  readonly #settings = new Map<MarketId, MarketPayoutSettings>();

  constructor(private readonly markets: MarketRegistry) {}

  get(marketId: MarketId): MarketPayoutSettings {
    const cached = this.#settings.get(marketId);
    if (cached !== undefined) return cached;
    const market = this.markets.get(marketId);
    const settings: MarketPayoutSettings = Object.freeze({
      marketId,
      currency: market.settlementCurrency,
      timezone: market.timezone,
      ...market.payouts,
    });
    this.#settings.set(marketId, settings);
    return settings;
  }
}
