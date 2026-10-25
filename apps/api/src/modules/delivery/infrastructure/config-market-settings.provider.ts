import type { MarketId } from '@mondapac-drive/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { ServiceAreaDirectory } from '../../../platform/market-config/service-area-directory';
import type { MarketSettingsProvider } from '../application/ports';
import type { MarketDeliverySettings } from '../domain/market-settings';
import type { ServiceArea } from '../domain/service-area';

/**
 * {@link MarketSettingsProvider} over the platform's Market configuration: the `delivery` and
 * `tax` sections and the conventions of `config/markets/<CODE>.json`, validated at start-up, and
 * the service areas of `config/service-areas/<CODE>.json`.
 */
export class ConfigMarketSettingsProvider implements MarketSettingsProvider {
  readonly #settings = new Map<MarketId, MarketDeliverySettings>();

  constructor(
    private readonly markets: MarketRegistry,
    private readonly areas: ServiceAreaDirectory,
  ) {}

  get(marketId: MarketId): MarketDeliverySettings {
    const cached = this.#settings.get(marketId);
    if (cached !== undefined) return cached;
    const market = this.markets.get(marketId);
    const settings: MarketDeliverySettings = Object.freeze({
      marketId,
      currency: market.defaultCurrency,
      timezone: market.timezone,
      pricesIncludeTax: market.pricesIncludeTax,
      taxRateBps: market.tax.defaultRateBps,
      rateCard: market.delivery.rateCard,
      coldChain: market.delivery.coldChain,
      scheduling: market.delivery.scheduling,
      proofOfDelivery: market.delivery.proofOfDelivery,
      responseBudget: market.delivery.responseBudget,
    });
    this.#settings.set(marketId, settings);
    return settings;
  }

  areaFor(marketId: MarketId, postcode: string): ServiceArea | undefined {
    return this.areas.areaFor(marketId, postcode);
  }
}
